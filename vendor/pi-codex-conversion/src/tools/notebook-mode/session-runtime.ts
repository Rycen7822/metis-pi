import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeExecutionClient, NotebookRuntimeOptions } from "../code-mode/shared-runtime.ts";
import type { CodeModeNestedRenderStore } from "../code-mode/trace-render-state.ts";
import type {
	CodeModeToolDefinition,
	NotebookControlRequest,
	NotebookControlResult,
	NotebookMemoryUsage,
	RuntimeResponse,
	ToolExecutionContext,
} from "../code-mode/types.ts";
import { resolveNotebookCheckpointMaxBytes } from "./checkpoint.ts";
import type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import { NotebookCheckpointManager } from "./checkpoint-manager.ts";
import { NotebookExecutionRuntime } from "./execution-runtime.ts";
import { materializeNotebookJournal, type NotebookJournal } from "./journal.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { runNotebookControl, disposeNotebookBindings } from "./lifecycle.ts";
import { extractNotebookNpmImports, recordNotebookNpmImports } from "./npm-imports.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import { readRetainedProjectBindings, type RetainedProjectBinding } from "./project-state-metadata.ts";
import {
	NOTEBOOK_INTERRUPTED_NOTICE,
	NOTEBOOK_BOOTSTRAP_NOTICE,
	isNotebookBootstrapFailure,
	NOTEBOOK_KERNEL_FAILURE_NOTICE,
	type NotebookRuntimeHealth,
	type NotebookRuntimeHealthState,
} from "./runtime-health.ts";
import { notebookSessionIdentity } from "./session-identity.ts";
import { startNotebookSession, type NotebookSessionStartOptions, type StartedNotebookSession } from "./session-startup.ts";

const MAX_NOTICE_CHARS = 16_384;

/**
 * The Notebook session owner: kernel, startup, session identity and checkpoint
 * state, plus the execution runtime it constructs. It also exposes the narrow
 * operation view that the lifecycle/recovery/profile modules consume and
 * satisfies CodeModeExecutionClient for the shared code-mode runtime.
 */
export class NotebookSessionRuntime implements CodeModeExecutionClient {
	readonly options: NotebookRuntimeOptions;
	readonly checkpointMaxBytes: number;
	readonly checkpoints: NotebookCheckpointManager;
	private readonly execution: NotebookExecutionRuntime;
	private kernelValue: DenoJupyterKernel | undefined;
	private runtimeHealthValue: NotebookRuntimeHealthState = "not_started";
	private identityValue: string | undefined;
	private checkpointIdentityValue: NotebookCheckpointIdentity | undefined;
	private startup: Promise<void> | undefined;
	private startupAbort: AbortController | undefined;
	private notice: string | undefined;
	private memoryValue: NotebookMemoryUsage | undefined;
	private journalValue: NotebookJournal | undefined;
	private extensionContext: ExtensionContext | undefined;
	private baseline = new Set<string>();
	private startedAtValue: number | undefined;
	private profileLoaded = false;

	constructor(
		options: NotebookRuntimeOptions,
		renderStore?: CodeModeNestedRenderStore,
	) {
		this.options = options;
		this.checkpointMaxBytes = resolveNotebookCheckpointMaxBytes(options.maxHeapMiB);
		this.execution = new NotebookExecutionRuntime(this, renderStore);
		this.checkpoints = new NotebookCheckpointManager({
			maxBytes: this.checkpointMaxBytes,
			currentKernel: () => this.kernelValue,
			runningCellId: () => this.execution.runningCellId(),
			reportNotice: (notice, showInUi) => {
				this.addNotice(notice);
				if (showInUi) this.extensionContext?.ui.notify(notice, "warning");
			},
		});
	}

	// ── CodeModeExecutionClient ─────────────────────────────────────────────

	execute(
		source: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		tools: CodeModeToolDefinition[] = [],
	): Promise<RuntimeResponse> {
		return this.execution.execute(source, context, signal, tools);
	}

	wait(
		cellId: string,
		yieldTimeMs: number,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		return this.execution.wait(cellId, yieldTimeMs, context, signal);
	}

	terminate(
		cellId: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		return this.execution.terminate(cellId, context, signal);
	}

	/** Identity check + lazy startup: the single preparation entry for every operation. */
	async prepare(context: ToolExecutionContext, signal?: AbortSignal): Promise<void> {
		const extension = context.extensionContext;
		if (!extension) throw new Error("Notebook Code Mode requires an extension session context");
		if (!this.identityMatches(extension)) await this.shutdown();
		await this.ensure(context, signal);
	}

	/** Persist the kernel's private bindings, then materialize the journal. */
	async checkpoint(
		excludeNames?: ReadonlySet<string>,
		pins?: { names: readonly string[]; pinned: boolean },
	): Promise<void> {
		try {
			await this.checkpoints.flush({ requireIdle: true, force: true, excludeNames, pins });
		} catch (error) {
			await this.recoverFromBootstrapFailure(error);
			throw error;
		}
		try {
			this.materializeJournal();
		} catch (error) {
			if (!pins) throw error;
			this.addNotice(`Notebook journal was not materialized: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async controlNotebook(
		request: NotebookControlRequest,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		let result: NotebookControlResult;
		try {
			result = await runNotebookControl(this, request, context, signal);
		} catch (error) {
			await this.recoverFromBootstrapFailure(error);
			throw error;
		}
		const notice = this.takeNotice();
		return notice
			? { message: `${notice}\n${result.message}`, details: { ...result.details, startupNotice: notice } }
			: result;
	}

	async shutdown(): Promise<void> {
		await this.abortStartup(new Error("Notebook session is shutting down"));
		await this.execution.stopActive().catch(() => undefined);
		await this.checkpoints.flush({ force: true }).catch(() => undefined);
		try { this.materializeJournal(); } catch {}
		await disposeNotebookBindings(this, AbortSignal.timeout(1_500)).catch(() => undefined);
		this.execution.clear();
		await this.teardown();
	}

	// ── Lifecycle / recovery / profile operation view ───────────────────────

	kernel(): DenoJupyterKernel | undefined { return this.kernelValue; }
	activeCellId(): string | undefined { return this.execution.activeCellId(); }
	stopActive(): Promise<string | undefined> { return this.execution.stopActive(); }
	markChanged(): void { this.checkpoints.schedule(); }

	/** Stop the running cell and drop the session kernel without checkpointing it. */
	async stopWithoutCheckpoint(): Promise<string | undefined> {
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

	identityMatches(context: ExtensionContext): boolean {
		return !this.identityValue || this.identityValue === sessionIdentity(context);
	}

	async ensure(context: ToolExecutionContext, signal?: AbortSignal): Promise<void> {
		const extension = context.extensionContext;
		if (!extension) throw new Error("Notebook Code Mode requires an extension session context");
		this.extensionContext = extension;
		if (!this.startup) {
			this.identityValue = sessionIdentity(extension);
			this.beginStartup(extension, signal);
		}
		await this.startup;
	}

	async restart(context: ExtensionContext, signal?: AbortSignal, skipProfile = false): Promise<string | undefined> {
		await this.abortStartup(new Error("Notebook kernel is restarting"));
		try { this.materializeJournal(); } catch {}
		const previous = this.detachKernel("not_started");
		await this.checkpoints.discard();
		await previous?.shutdown().catch(() => undefined);
		await this.beginStartup(context, signal, skipProfile);
		return this.takeNotice();
	}

	async invalidateKernel(notice = NOTEBOOK_INTERRUPTED_NOTICE): Promise<void> {
		const kernel = this.detachKernel("invalidated");
		this.addNotice(notice);
		await kernel?.shutdown().catch(() => undefined);
	}

	async recoverFromBootstrapFailure(value: unknown): Promise<boolean> {
		if (!isNotebookBootstrapFailure(value)) return false;
		if (this.kernelValue) await this.invalidateKernel(NOTEBOOK_BOOTSTRAP_NOTICE);
		return true;
	}

	async abortStartup(reason: Error): Promise<void> {
		this.startupAbort?.abort(reason);
		await this.startup?.catch(() => undefined);
	}

	runtimeHealth(): NotebookRuntimeHealth { return { state: this.runtimeHealthValue }; }
	runtimeHealthFor(context: ExtensionContext): NotebookRuntimeHealth {
		return this.identityMatches(context) ? this.runtimeHealth() : { state: "not_started" };
	}
	journal(): NotebookJournal | undefined { return this.journalValue; }
	materializeJournal(): void {
		if (this.journalValue) materializeNotebookJournal(this.journalValue);
	}
	baselineNames(): ReadonlySet<string> { return this.baseline; }
	configuredProfileActive(): boolean { return this.profileLoaded; }
	retainedBindings(): RetainedProjectBinding[] {
		return this.checkpointIdentityValue
			? readRetainedProjectBindings(this.checkpointIdentityValue, this.checkpointMaxBytes)
			: [];
	}
	recordMemory(memory: NotebookMemoryUsage | undefined): void { this.memoryValue = memory; }
	async recordNpmImports(source: string): Promise<void> {
		const identity = this.checkpointIdentityValue;
		if (!identity) return;
		const imports = extractNotebookNpmImports(source);
		if (imports.length === 0) return;
		try {
			await recordNotebookNpmImports(identity, imports);
		} catch (error) {
			this.addNotice(`Notebook npm inventory was not updated: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	memory(): NotebookMemoryUsage | undefined { return this.memoryValue; }
	addNotice(notice: string): void { this.notice = joinNotices(this.notice, notice); }
	takeNotice(): string | undefined {
		const notice = this.notice;
		this.notice = undefined;
		return notice;
	}

	metadata(): {
		startedAt?: number | undefined;
		userCells: number;
		memory?: NotebookMemoryUsage | undefined;
		checkpoint: Record<string, unknown>;
	} {
		return {
			startedAt: this.startedAtValue,
			userCells: this.journalValue?.completedCells ?? 0,
			memory: this.memoryValue,
			checkpoint: this.checkpoints.status(),
		};
	}

	private async teardown(): Promise<void> {
		await this.abortStartup(new Error("Notebook session is shutting down"));
		try { this.materializeJournal(); } catch {}
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
	private detachKernel(health: NotebookRuntimeHealthState): DenoJupyterKernel | undefined {
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

	private async start(context: ExtensionContext, signal?: AbortSignal, skipProfile = false): Promise<void> {
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
	protected startSession(options: NotebookSessionStartOptions): Promise<StartedNotebookSession> {
		return startNotebookSession(options);
	}

	private handleKernelFailure(kernel: DenoJupyterKernel): void {
		if (this.kernelValue !== kernel) return;
		this.detachKernel("invalidated");
		this.addNotice(NOTEBOOK_KERNEL_FAILURE_NOTICE);
	}

	private beginStartup(context: ExtensionContext, signal?: AbortSignal, skipProfile = false): Promise<void> {
		const startupAbort = new AbortController();
		const startupSignal = signal ? AbortSignal.any([signal, startupAbort.signal]) : startupAbort.signal;
		this.startupAbort = startupAbort;
		const pending = this.start(context, startupSignal, skipProfile)
			.catch((error) => {
				if (this.startup === pending) this.startup = undefined;
				throw error;
			})
			.finally(() => {
				if (this.startupAbort === startupAbort) this.startupAbort = undefined;
			});
		this.startup = pending;
		return pending;
	}
}

function sessionIdentity(context: ExtensionContext): string {
	return `${notebookSessionIdentity(context)}\0${resolveNotebookProject(context.cwd)}`;
}

function joinNotices(...notices: Array<string | undefined>): string | undefined {
	const present = notices.filter((notice): notice is string => Boolean(notice));
	if (present.length === 0) return undefined;
	const marker = " [Notebook notices truncated]";
	let output = "";
	for (let index = 0; index < present.length; index += 1) {
		const notice = present[index]!;
		const separator = output ? ". " : "";
		const remaining = MAX_NOTICE_CHARS - output.length - separator.length;
		if (remaining <= 0 || notice.length > remaining || index < present.length - 1 && notice.length === remaining) {
			return `${output}${separator}${notice.slice(0, Math.max(0, remaining - marker.length))}${marker}`.slice(0, MAX_NOTICE_CHARS);
		}
		output += `${separator}${notice}`;
	}
	return output;
}
