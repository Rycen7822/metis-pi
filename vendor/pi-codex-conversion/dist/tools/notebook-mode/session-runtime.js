import { resolveNotebookCheckpointMaxBytes } from "./checkpoint.js";
import { NotebookCheckpointManager } from "./checkpoint-manager.js";
import { NotebookExecutionRuntime } from "./execution-runtime.js";
import { materializeNotebookJournal } from "./journal.js";
import { runNotebookControl, disposeNotebookBindings } from "./lifecycle.js";
import { extractNotebookNpmImports, recordNotebookNpmImports } from "./npm-imports.js";
import { resolveNotebookProject } from "./project-identity.js";
import { readRetainedProjectBindings } from "./project-state-metadata.js";
import { NOTEBOOK_INTERRUPTED_NOTICE, NOTEBOOK_BOOTSTRAP_NOTICE, isNotebookBootstrapFailure, NOTEBOOK_KERNEL_FAILURE_NOTICE, } from "./runtime-health.js";
import { notebookSessionIdentity } from "./session-identity.js";
import { startNotebookSession } from "./session-startup.js";
const MAX_NOTICE_CHARS = 16_384;
/**
 * The Notebook session owner: kernel, startup, session identity and checkpoint
 * state, plus the execution runtime it constructs. It also exposes the narrow
 * operation view that the lifecycle/recovery/profile modules consume and
 * satisfies CodeModeExecutionClient for the shared code-mode runtime.
 */
export class NotebookSessionRuntime {
    options;
    checkpointMaxBytes;
    checkpoints;
    execution;
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
    constructor(options, renderStore) {
        this.options = options;
        this.checkpointMaxBytes = resolveNotebookCheckpointMaxBytes(options.maxHeapMiB);
        this.execution = new NotebookExecutionRuntime(this, renderStore);
        this.checkpoints = new NotebookCheckpointManager({
            maxBytes: this.checkpointMaxBytes,
            currentKernel: () => this.kernelValue,
            runningCellId: () => this.execution.runningCellId(),
            reportNotice: (notice, showInUi) => {
                this.addNotice(notice);
                if (showInUi)
                    this.extensionContext?.ui.notify(notice, "warning");
            },
        });
    }
    // ── CodeModeExecutionClient ─────────────────────────────────────────────
    execute(source, context, signal, tools = []) {
        return this.execution.execute(source, context, signal, tools);
    }
    wait(cellId, yieldTimeMs, context, signal) {
        return this.execution.wait(cellId, yieldTimeMs, context, signal);
    }
    terminate(cellId, context, signal) {
        return this.execution.terminate(cellId, context, signal);
    }
    /** Identity check + lazy startup: the single preparation entry for every operation. */
    async prepare(context, signal) {
        const extension = context.extensionContext;
        if (!extension)
            throw new Error("Notebook Code Mode requires an extension session context");
        if (!this.identityMatches(extension))
            await this.shutdown();
        await this.ensure(context, signal);
    }
    /** Persist the kernel's private bindings, then materialize the journal. */
    async checkpoint(excludeNames, pins) {
        try {
            await this.checkpoints.flush({ requireIdle: true, force: true, excludeNames, pins });
        }
        catch (error) {
            await this.recoverFromBootstrapFailure(error);
            throw error;
        }
        try {
            this.materializeJournal();
        }
        catch (error) {
            if (!pins)
                throw error;
            this.addNotice(`Notebook journal was not materialized: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async controlNotebook(request, context, signal) {
        let result;
        try {
            result = await runNotebookControl(this, request, context, signal);
        }
        catch (error) {
            await this.recoverFromBootstrapFailure(error);
            throw error;
        }
        const notice = this.takeNotice();
        return notice
            ? { message: `${notice}\n${result.message}`, details: { ...result.details, startupNotice: notice } }
            : result;
    }
    async shutdown() {
        await this.abortStartup(new Error("Notebook session is shutting down"));
        await this.execution.stopActive().catch(() => undefined);
        await this.checkpoints.flush({ force: true }).catch(() => undefined);
        try {
            this.materializeJournal();
        }
        catch { }
        await disposeNotebookBindings(this, AbortSignal.timeout(1_500)).catch(() => undefined);
        this.execution.clear();
        await this.teardown();
    }
    // ── Lifecycle / recovery / profile operation view ───────────────────────
    kernel() { return this.kernelValue; }
    activeCellId() { return this.execution.activeCellId(); }
    stopActive() { return this.execution.stopActive(); }
    markChanged() { this.checkpoints.schedule(); }
    /** Stop the running cell and drop the session kernel without checkpointing it. */
    async stopWithoutCheckpoint() {
        const activeCell = await this.execution.stopActive();
        this.execution.clear();
        this.startupAbort?.abort(new Error("Notebook state is being reset"));
        await this.startup?.catch(() => undefined);
        const previous = this.detachKernel("not_started");
        await this.checkpoints.discard();
        this.notice = undefined;
        await previous?.shutdown().catch(() => undefined);
        return activeCell;
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
        const previous = this.detachKernel("not_started");
        await this.checkpoints.discard();
        await previous?.shutdown().catch(() => undefined);
        await this.beginStartup(context, signal, skipProfile);
        return this.takeNotice();
    }
    async invalidateKernel(notice = NOTEBOOK_INTERRUPTED_NOTICE) {
        const kernel = this.detachKernel("invalidated");
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
    async abortStartup(reason) {
        this.startupAbort?.abort(reason);
        await this.startup?.catch(() => undefined);
    }
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
    configuredProfileActive() { return this.profileLoaded; }
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
    async teardown() {
        await this.abortStartup(new Error("Notebook session is shutting down"));
        try {
            this.materializeJournal();
        }
        catch { }
        const kernel = this.detachKernel("not_started");
        this.startupAbort = undefined;
        this.identityValue = undefined;
        this.checkpoints.reset();
        this.notice = undefined;
        this.journalValue = undefined;
        this.extensionContext = undefined;
        this.baseline.clear();
        await kernel?.shutdown().catch(() => undefined);
        await this.execution.bridge.shutdown();
    }
    /** Detach the current kernel and forget every value derived from its identity. */
    detachKernel(health) {
        const kernel = this.kernelValue;
        this.kernelValue = undefined;
        this.runtimeHealthValue = health;
        this.startup = undefined;
        this.memoryValue = undefined;
        this.startedAtValue = undefined;
        this.profileLoaded = false;
        this.checkpointIdentityValue = undefined;
        return kernel;
    }
    async start(context, signal, skipProfile = false) {
        this.identityValue = sessionIdentity(context);
        this.extensionContext = context;
        this.memoryValue = undefined;
        const started = await this.startSession({
            context,
            runtime: skipProfile && this.options.profile
                ? { ...this.options, profile: undefined }
                : this.options,
            bridge: this.execution.bridge,
            checkpointMaxBytes: this.checkpointMaxBytes,
            onKernelFailure: (kernel) => this.handleKernelFailure(kernel),
            ...(signal ? { signal } : {}),
        });
        if (signal?.aborted) {
            // The session was closed (or restarted) while the kernel was starting:
            // discard the late result instead of reviving a torn-down session.
            await started.kernel.shutdown().catch(() => undefined);
            return;
        }
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
    /** Session/kernel startup; tests override this to drive a controlled kernel. */
    startSession(options) {
        return startNotebookSession(options);
    }
    handleKernelFailure(kernel) {
        if (this.kernelValue !== kernel)
            return;
        this.detachKernel("invalidated");
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
