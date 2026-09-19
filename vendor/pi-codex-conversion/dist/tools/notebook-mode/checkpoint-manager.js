import { writeNotebookCheckpoint } from "./checkpoint.js";
import { writeProjectState } from "./project-state.js";
import { projectStateEntryFingerprint } from "./project-state-merge.js";
const CHECKPOINT_DEBOUNCE_MS = 1_500;
export class NotebookCheckpointManager {
    maxBytes;
    currentKernel;
    runningCellId;
    reportNotice;
    baselineNames = new Set();
    identity;
    projectBaseline = { generation: "root", entries: [] };
    timer;
    dirty = false;
    maintenance = Promise.resolve();
    lastCheckpointAt;
    constructor(options) {
        this.maxBytes = options.maxBytes;
        this.currentKernel = options.currentKernel;
        this.runningCellId = options.runningCellId;
        this.reportNotice = options.reportNotice;
    }
    configure(identity, baselineNames, projectBaseline) {
        this.identity = identity;
        this.baselineNames = baselineNames;
        this.projectBaseline = projectBaseline;
    }
    schedule() {
        this.dirty = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => undefined);
        }, CHECKPOINT_DEBOUNCE_MS);
        this.timer.unref?.();
    }
    flush(options = {}) {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        const operation = this.maintenance.then(() => this.perform(options));
        this.maintenance = operation.catch(() => undefined);
        return operation;
    }
    reset() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.baselineNames.clear();
        this.identity = undefined;
        this.projectBaseline = { generation: "root", entries: [] };
        this.dirty = false;
        this.maintenance = Promise.resolve();
        this.lastCheckpointAt = undefined;
    }
    async discard() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        await this.maintenance;
        this.reset();
    }
    status() {
        return {
            dirty: this.dirty,
            projectGeneration: this.projectBaseline.generation,
            projectBindings: this.projectBaseline.entries.length,
            ...(this.lastCheckpointAt ? { lastCheckpointAt: this.lastCheckpointAt } : {}),
        };
    }
    async perform(options) {
        const runningCellId = this.runningCellId();
        if (runningCellId) {
            if (!options.requireIdle)
                return;
            const notice = `Notebook checkpoint skipped because cell "${runningCellId}" is still running; the last completed checkpoint remains available`;
            this.reportNotice(notice, false);
            throw new Error(notice);
        }
        const kernel = this.currentKernel();
        if ((!options.force && !this.dirty) || !kernel || !this.identity)
            return;
        this.dirty = false;
        let projectFailure;
        const projectExclusions = new Set(options.excludeNames ?? []);
        try {
            const project = await writeProjectState(kernel, this.identity, this.projectBaseline, this.baselineNames, this.maxBytes, options.excludeNames, options.pins);
            this.projectBaseline = project.baseline;
            const sessionEntries = new Map(project.baseline.entries.map((entry) => [entry.name, entry]));
            for (const entry of project.restored) {
                if (projectStateEntryFingerprint(sessionEntries.get(entry.name)) === projectStateEntryFingerprint(entry)) {
                    projectExclusions.add(entry.name);
                }
            }
            if (project.conflicts.length > 0) {
                this.reportNotice(`Project notebook conflicts preserved without overwrite: ${project.conflicts.join(", ")}`, false);
            }
            if (project.message)
                this.reportNotice(project.message, false);
        }
        catch (error) {
            this.dirty = true;
            const notice = `Project notebook checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
            this.reportNotice(notice, true);
            projectFailure = new Error(notice, { cause: error });
        }
        if (projectFailure && options.pins)
            throw projectFailure;
        try {
            await writeNotebookCheckpoint(kernel, this.identity, this.baselineNames, this.maxBytes, this.projectBaseline, projectExclusions);
        }
        catch (error) {
            this.dirty = true;
            const notice = `Session notebook checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
            this.reportNotice(notice, true);
            if (options.pins && !projectFailure)
                return;
            throw new Error(notice, { cause: error });
        }
        if (projectFailure)
            throw projectFailure;
        this.lastCheckpointAt = new Date().toISOString();
    }
}
