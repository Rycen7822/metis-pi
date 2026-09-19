import { resolveNotebookCheckpointMaxBytes } from "./checkpoint.js";
import { NotebookCheckpointManager } from "./checkpoint-manager.js";
import { materializeNotebookJournal } from "./journal.js";
import { extractNotebookNpmImports, recordNotebookNpmImports } from "./npm-imports.js";
import { resolveNotebookProject } from "./project-identity.js";
import { readRetainedProjectBindings } from "./project-state-metadata.js";
import { NOTEBOOK_INTERRUPTED_NOTICE, NOTEBOOK_BOOTSTRAP_NOTICE, isNotebookBootstrapFailure, NOTEBOOK_KERNEL_FAILURE_NOTICE, } from "./runtime-health.js";
import { startNotebookSession } from "./session-startup.js";
import { notebookSessionIdentity } from "./session-identity.js";
const MAX_NOTICE_CHARS = 16_384;
export class NotebookSessionRuntime {
    options;
    checkpointMaxBytes;
    checkpoints;
    bridge;
    runningCellId;
    kernelValue;
    runtimeHealthValue = "not_started";
    identityValue;
    checkpointIdentityValue;
    startup;
    startupAbort;
    notice;
    memoryValue;
    journalValue;
    extensionContext;
    baseline = new Set();
    startedAtValue;
    profileLoaded = false;
    constructor(options) {
        this.options = options.runtime;
        this.bridge = options.bridge;
        this.runningCellId = options.runningCellId;
        this.checkpointMaxBytes = resolveNotebookCheckpointMaxBytes(options.runtime.maxHeapMiB);
        this.checkpoints = new NotebookCheckpointManager({
            maxBytes: this.checkpointMaxBytes,
            currentKernel: () => this.kernelValue,
            runningCellId: this.runningCellId,
            reportNotice: (notice, showInUi) => {
                this.addNotice(notice);
                if (showInUi)
                    this.extensionContext?.ui.notify(notice, "warning");
            },
        });
    }
    identityMatches(context) {
        return !this.identityValue || this.identityValue === sessionIdentity(context);
    }
    async ensure(context, signal) {
        const extension = context.extensionContext;
        if (!extension)
            throw new Error("Notebook Code Mode requires an extension session context");
        this.extensionContext = extension;
        if (!this.startup) {
            this.identityValue = sessionIdentity(extension);
            this.beginStartup(extension, signal);
        }
        await this.startup;
    }
    async restart(context, signal, skipProfile = false) {
        await this.abortStartup(new Error("Notebook kernel is restarting"));
        try {
            this.materializeJournal();
        }
        catch { }
        const previous = this.kernelValue;
        this.kernelValue = undefined;
        this.runtimeHealthValue = "not_started";
        this.startup = undefined;
        await this.checkpoints.discard();
        this.memoryValue = undefined;
        this.startedAtValue = undefined;
        this.profileLoaded = false;
        this.checkpointIdentityValue = undefined;
        await previous?.shutdown().catch(() => undefined);
        const pending = this.beginStartup(context, signal, skipProfile);
        await pending;
        return this.takeNotice();
    }
    async invalidateKernel(notice = NOTEBOOK_INTERRUPTED_NOTICE) {
        const kernel = this.kernelValue;
        this.kernelValue = undefined;
        this.runtimeHealthValue = "invalidated";
        this.startup = undefined;
        this.memoryValue = undefined;
        this.startedAtValue = undefined;
        this.profileLoaded = false;
        this.checkpointIdentityValue = undefined;
        this.addNotice(notice);
        await kernel?.shutdown().catch(() => undefined);
    }
    async recoverFromBootstrapFailure(value) {
        if (!isNotebookBootstrapFailure(value))
            return false;
        if (this.kernelValue)
            await this.invalidateKernel(NOTEBOOK_BOOTSTRAP_NOTICE);
        return true;
    }
    async stopWithoutCheckpoint() {
        this.startupAbort?.abort(new Error("Notebook state is being reset"));
        await this.startup?.catch(() => undefined);
        const previous = this.kernelValue;
        this.kernelValue = undefined;
        this.runtimeHealthValue = "not_started";
        this.startup = undefined;
        await this.checkpoints.discard();
        this.memoryValue = undefined;
        this.startedAtValue = undefined;
        this.profileLoaded = false;
        this.checkpointIdentityValue = undefined;
        this.notice = undefined;
        await previous?.shutdown().catch(() => undefined);
    }
    async abortStartup(reason) {
        this.startupAbort?.abort(reason);
        await this.startup?.catch(() => undefined);
    }
    async shutdown() {
        await this.abortStartup(new Error("Notebook session is shutting down"));
        try {
            this.materializeJournal();
        }
        catch { }
        const kernel = this.kernelValue;
        this.kernelValue = undefined;
        this.runtimeHealthValue = "not_started";
        this.startup = undefined;
        this.startupAbort = undefined;
        this.identityValue = undefined;
        this.checkpointIdentityValue = undefined;
        this.checkpoints.reset();
        this.notice = undefined;
        this.memoryValue = undefined;
        this.journalValue = undefined;
        this.extensionContext = undefined;
        this.baseline.clear();
        this.startedAtValue = undefined;
        this.profileLoaded = false;
        await kernel?.shutdown().catch(() => undefined);
        await this.bridge.shutdown();
    }
    kernel() { return this.kernelValue; }
    runtimeHealth() { return { state: this.runtimeHealthValue }; }
    runtimeHealthFor(context) {
        return this.identityMatches(context) ? this.runtimeHealth() : { state: "not_started" };
    }
    journal() { return this.journalValue; }
    materializeJournal() {
        if (this.journalValue)
            materializeNotebookJournal(this.journalValue);
    }
    baselineNames() { return this.baseline; }
    configuredProfileLoaded() { return this.profileLoaded; }
    retainedBindings() {
        return this.checkpointIdentityValue
            ? readRetainedProjectBindings(this.checkpointIdentityValue, this.checkpointMaxBytes)
            : [];
    }
    recordMemory(memory) { this.memoryValue = memory; }
    async recordNpmImports(source) {
        const identity = this.checkpointIdentityValue;
        if (!identity)
            return;
        const imports = extractNotebookNpmImports(source);
        if (imports.length === 0)
            return;
        try {
            await recordNotebookNpmImports(identity, imports);
        }
        catch (error) {
            this.addNotice(`Notebook npm inventory was not updated: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    memory() { return this.memoryValue; }
    addNotice(notice) { this.notice = joinNotices(this.notice, notice); }
    takeNotice() {
        const notice = this.notice;
        this.notice = undefined;
        return notice;
    }
    metadata() {
        return {
            startedAt: this.startedAtValue,
            userCells: this.journalValue?.completedCells ?? 0,
            memory: this.memoryValue,
            checkpoint: this.checkpoints.status(),
        };
    }
    async start(context, signal, skipProfile = false) {
        this.identityValue = sessionIdentity(context);
        this.extensionContext = context;
        this.memoryValue = undefined;
        const started = await startNotebookSession({
            context,
            runtime: skipProfile && this.options.profile
                ? { ...this.options, profile: undefined }
                : this.options,
            bridge: this.bridge,
            checkpointMaxBytes: this.checkpointMaxBytes,
            onKernelFailure: (kernel) => this.handleKernelFailure(kernel),
            ...(signal ? { signal } : {}),
        });
        this.kernelValue = started.kernel;
        this.startedAtValue = Date.now();
        this.journalValue = started.journal;
        this.checkpointIdentityValue = started.checkpointIdentity;
        this.baseline = started.baselineNames;
        this.profileLoaded = started.configuredProfileLoaded;
        this.runtimeHealthValue = "ready";
        this.checkpoints.configure(started.checkpointIdentity, started.baselineNames, started.projectBaseline);
        if (started.restoreNotice) {
            this.addNotice(started.restoreNotice);
        }
    }
    handleKernelFailure(kernel) {
        if (this.kernelValue !== kernel)
            return;
        this.kernelValue = undefined;
        this.runtimeHealthValue = "invalidated";
        this.startup = undefined;
        this.memoryValue = undefined;
        this.startedAtValue = undefined;
        this.profileLoaded = false;
        this.checkpointIdentityValue = undefined;
        this.addNotice(NOTEBOOK_KERNEL_FAILURE_NOTICE);
    }
    beginStartup(context, signal, skipProfile = false) {
        const startupAbort = new AbortController();
        const startupSignal = signal ? AbortSignal.any([signal, startupAbort.signal]) : startupAbort.signal;
        this.startupAbort = startupAbort;
        const pending = this.start(context, startupSignal, skipProfile)
            .catch((error) => {
            if (this.startup === pending)
                this.startup = undefined;
            throw error;
        })
            .finally(() => {
            if (this.startupAbort === startupAbort)
                this.startupAbort = undefined;
        });
        this.startup = pending;
        return pending;
    }
}
function sessionIdentity(context) {
    return `${notebookSessionIdentity(context)}\0${resolveNotebookProject(context.cwd)}`;
}
function joinNotices(...notices) {
    const present = notices.filter((notice) => Boolean(notice));
    if (present.length === 0)
        return undefined;
    const marker = " [Notebook notices truncated]";
    let output = "";
    for (let index = 0; index < present.length; index += 1) {
        const notice = present[index];
        const separator = output ? ". " : "";
        const remaining = MAX_NOTICE_CHARS - output.length - separator.length;
        if (remaining <= 0 || notice.length > remaining || index < present.length - 1 && notice.length === remaining) {
            return `${output}${separator}${notice.slice(0, Math.max(0, remaining - marker.length))}${marker}`.slice(0, MAX_NOTICE_CHARS);
        }
        output += `${separator}${notice}`;
    }
    return output;
}
