import { NotebookExecutionRuntime } from "./execution-runtime.js";
import { NotebookLifecycleController } from "./lifecycle.js";
import { NotebookRecoveryController } from "./recovery.js";
import { NotebookSessionRuntime } from "./session-runtime.js";
import { promoteProjectStateBindings, projectStateBindingSelection, syncProjectStateBindings, } from "./project-state.js";
export class NotebookCodeModeClient {
    execution;
    session;
    lifecycle;
    recovery;
    constructor(options, renderStore) {
        let session;
        this.execution = new NotebookExecutionRuntime(() => session, (context, signal) => this.prepareSession(context, signal), renderStore);
        this.session = session = new NotebookSessionRuntime({
            runtime: options,
            bridge: this.execution.bridge,
            runningCellId: () => this.execution.runningCellId(),
        });
        this.recovery = new NotebookRecoveryController({
            agentDir: options.agentDir,
            maxBytes: session.checkpointMaxBytes,
            profile: options.profile,
        }, {
            stopWithoutCheckpoint: () => this.stopWithoutCheckpoint(),
            startClean: async (context, signal) => { await session.restart(context, signal, true); },
            checkpointEmpty: () => session.checkpoints.flush({ force: true, requireIdle: true }),
            configuredProfileActive: () => session.configuredProfileLoaded(),
            runtimeHealth: (context) => session.runtimeHealthFor(context),
        });
        this.lifecycle = new NotebookLifecycleController({
            prepare: (context, signal) => this.prepareSession(context, signal),
            diagnostics: (context, signal) => this.recovery.diagnostics(context, signal),
            reset: (context, signal) => this.recovery.reset(context, signal),
            kernel: () => session.kernel(),
            activeCellId: () => this.execution.activeCellId(),
            stopActive: () => this.execution.stopActive(),
            checkpoint: (excludeNames, pins) => this.checkpoint(excludeNames, pins),
            retainedBindings: () => session.retainedBindings(),
            promoteBindings: async (names) => {
                const kernel = session.kernel();
                if (!kernel)
                    throw new Error("Notebook kernel is unavailable");
                const previous = await projectStateBindingSelection(kernel);
                try {
                    await promoteProjectStateBindings(kernel, names);
                }
                catch (error) {
                    await syncProjectStateBindings(kernel, previous).catch(() => undefined);
                    throw error;
                }
                return () => syncProjectStateBindings(kernel, previous);
            },
            markChanged: () => session.checkpoints.schedule(),
            restart: (context, signal) => session.restart(context, signal),
            rollback: async (context) => { await session.restart(context, undefined, true); },
            baselineNames: () => session.baselineNames(),
            profileStorage: () => ({ agentDir: options.agentDir, maxBytes: session.checkpointMaxBytes }),
            metadata: () => session.metadata(),
            runtimeHealth: () => session.runtimeHealth(),
        });
    }
    execute(source, context, signal, tools = []) {
        return this.execution.execute(source, context, signal, tools);
    }
    wait(cellId, yieldTimeMs, context, signal) {
        return this.execution.wait(cellId, yieldTimeMs, context, signal);
    }
    terminate(cellId, context, signal) {
        return this.execution.terminate(cellId, context, signal);
    }
    async checkpoint(excludeNames, pins) {
        try {
            await this.session.checkpoints.flush({ requireIdle: true, force: true, excludeNames, pins });
        }
        catch (error) {
            await this.session.recoverFromBootstrapFailure(error);
            throw error;
        }
        try {
            this.session.materializeJournal();
        }
        catch (error) {
            if (!pins)
                throw error;
            this.session.addNotice(`Notebook journal was not materialized: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async controlNotebook(request, context, signal) {
        let result;
        try {
            result = await this.lifecycle.control(request, context, signal);
        }
        catch (error) {
            await this.session.recoverFromBootstrapFailure(error);
            throw error;
        }
        const notice = this.session.takeNotice();
        return notice
            ? { message: `${notice}\n${result.message}`, details: { ...result.details, startupNotice: notice } }
            : result;
    }
    async shutdown() {
        await this.session.abortStartup(new Error("Notebook session is shutting down"));
        await this.execution.stopActive().catch(() => undefined);
        await this.session.checkpoints.flush({ force: true }).catch(() => undefined);
        try {
            this.session.materializeJournal();
        }
        catch { }
        await this.lifecycle.disposeAll(AbortSignal.timeout(1_500)).catch(() => undefined);
        this.execution.clear();
        await this.session.shutdown();
    }
    async prepareSession(context, signal) {
        const extension = context.extensionContext;
        if (!extension)
            throw new Error("Notebook Code Mode requires an extension session context");
        if (!this.session.identityMatches(extension))
            await this.shutdown();
        await this.session.ensure(context, signal);
    }
    async stopWithoutCheckpoint() {
        const activeCell = await this.execution.stopActive();
        this.execution.clear();
        await this.session.stopWithoutCheckpoint();
        return activeCell;
    }
}
