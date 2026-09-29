import { randomUUID } from "node:crypto";
import { withPlainCommandOutput } from "./command-output.ts";
import { CodeModeDelegateRuntime } from "./delegate-runtime.ts";
import { CodeModeHostConnection } from "./host-connection.ts";
import {
	abortError,
	cancelOperation,
	throwIfAborted,
	toError,
	waitWithSignal,
} from "./host-operation.ts";
import {
	DEFAULT_CODE_MODE_EXEC_YIELD_MS,
	executionCellId,
	isMissingRuntimeOutcome,
	parseExecSource,
	parseRuntimeResponse,
	runtimeOutcome,
	toWireToolDefinition,
	type HostMessage,
} from "./host-protocol.ts";
import {
	directToolYieldTime,
	scopeAllToolsToDeferredCustom,
} from "./tool-source.ts";
import type { CodeModeNestedRenderStore } from "./trace-render-state.ts";
import type {
	CodeModeToolDefinition,
	RuntimeResponse,
	ToolExecutionContext,
} from "./types.ts";

export { scopeAllToolsToDeferredCustom } from "./tool-source.ts";

const DEFAULT_SHUTDOWN_GRACE_MS = 250;

type HostClientOptions = {
	binary: string;
	tools: CodeModeToolDefinition[];
	renderStore?: CodeModeNestedRenderStore | undefined;
	shutdownGraceMs?: number | undefined;
	startupTimeoutMs?: number | undefined;
};

/**
 * V8 host client: owns the framed process connection and the session protocol
 * (session/open, session/execute, session/wait, session/terminate, session/shutdown)
 * plus the delegate/cell replies arriving from the host.
 */
export class CodeModeHostClient {
	readonly id = randomUUID();
	private readonly tools: Map<string, CodeModeToolDefinition>;
	private readonly connection: CodeModeHostConnection;
	private readonly delegate: CodeModeDelegateRuntime;
	private readonly shutdownGraceMs: number;
	private ready: Promise<void> | undefined;
	private readonly startupTimeoutMs: number;

	constructor(options: HostClientOptions) {
		this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
		this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
		this.delegate = new CodeModeDelegateRuntime(
			(message) => this.connection.send(message),
			options.renderStore,
		);
		this.connection = new CodeModeHostConnection({
			binary: options.binary,
			onMessage: (message) => this.handleMessage(message),
			onFailure: () => {
				this.ready = undefined;
				this.delegate.clear();
			},
		});
	}

	async start(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (!this.ready) {
			let timer: ReturnType<typeof setTimeout>;
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Code-mode host startup timed out")), this.startupTimeoutMs);
			});
			const ready = Promise.race([this.startSession(), timeout]).catch((error: unknown) => {
				// A previous startup failure must not tear down a newer attempt.
				if (this.ready === ready) this.connection.close(toError(error));
				throw error;
			}).finally(() => clearTimeout(timer));
			this.ready = ready;
		}
		return waitWithSignal(this.ready, signal);
	}

	async execute(
		source: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		tools: CodeModeToolDefinition[] = [...this.tools.values()],
		preempt?: AbortSignal,
	): Promise<RuntimeResponse> {
		throwIfAborted(signal);
		// Freeze execution getters before asynchronous startup can change the active model.
		context = { ...context, extensionContext: context.extensionContext ? { ...context.extensionContext } : undefined };
		await this.start(signal);
		throwIfAborted(signal);
		const { code, yieldTimeMs, maxOutputTokens } = parseExecSource(source);
		const effectiveYieldTimeMs =
			directToolYieldTime(code, tools) ??
			yieldTimeMs ??
			DEFAULT_CODE_MODE_EXEC_YIELD_MS;
		const id = this.connection.nextRequestId();
		const initial = this.connection.expectInitial(id);
		void initial.catch(() => undefined);
		const toolSet = new Map(tools.map((tool) => [tool.name, tool]));
		const started = this.connection.requestWithId(
			id,
			{
				method: "session/execute",
				sessionId: this.id,
				request: {
					tool_call_id: `exec-${id}`,
					enabled_tools: tools.map(toWireToolDefinition),
					source: scopeAllToolsToDeferredCustom(withPlainCommandOutput(code, tools), tools),
					yield_time_ms: effectiveYieldTimeMs,
					max_output_tokens: maxOutputTokens,
				},
			},
			(value) => this.bindCell(value, context, toolSet),
		);
		const stopYield = this.observeYield(id, preempt);
		let cellId: string | undefined;
		const abort = () => {
			cancelOperation(this.connection, id);
			if (cellId) void this.terminate(cellId, context).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const startedValue = await started;
			cellId = executionCellId(startedValue);
			if (signal?.aborted) {
				abort();
				throw abortError();
			}
			const response = this.delegate.attach(parseRuntimeResponse(await initial));
			return {
				...(await this.waitForBlockers(response, context, effectiveYieldTimeMs, signal, preempt)),
				maxOutputTokens: maxOutputTokens ?? 10_000,
			};
		} catch (error) {
			this.connection.rejectOperation(id, toError(error));
			throw error;
		} finally {
			stopYield();
			signal?.removeEventListener("abort", abort);
		}
	}

	async wait(
		cellId: string,
		yieldTimeMs: number,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		preempt?: AbortSignal,
	): Promise<RuntimeResponse> {
		return this.waitForBlockers(
			await this.cellOperation(
				cellId,
				context,
				signal,
				{
					method: "session/wait",
					sessionId: this.id,
					request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
				},
				"Code-mode host returned an invalid wait outcome",
				preempt,
			),
			context,
			yieldTimeMs,
			signal,
			preempt,
		);
	}

	async terminate(
		cellId: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		return this.cellOperation(
			cellId,
			context,
			signal,
			{
				method: "session/terminate",
				sessionId: this.id,
				cellId,
			},
			"Code-mode host returned an invalid termination outcome",
		);
	}

	async shutdown(): Promise<void> {
		if (!this.connection.running) return;
		try {
			await Promise.race([
				this.connection.request({
					method: "session/shutdown",
					sessionId: this.id,
				}),
				shutdownDeadline(this.shutdownGraceMs),
			]);
		} catch {
			// Process teardown below is authoritative.
		}
		this.connection.close(new Error("Code-mode host shut down"));
	}

	private async startSession(): Promise<void> {
		await this.connection.start();
		await this.connection.request({
			method: "session/open",
			sessionId: this.id,
		});
	}

	private async waitForBlockers(
		response: RuntimeResponse,
		context: ToolExecutionContext,
		yieldTimeMs: number,
		signal?: AbortSignal,
		preempt?: AbortSignal,
	): Promise<RuntimeResponse> {
		let current = response;
		const yieldSignal = this.connection.supportsYield ? preempt : undefined;
		const blockerSignal = yieldSignal ? AbortSignal.any(signal ? [signal, yieldSignal] : [yieldSignal]) : signal;
		while (current.kind === "yielded" && this.delegate.isBlocked(current.cellId)) {
			throwIfAborted(signal);
			if (yieldSignal?.aborted) return current;
			try { await this.delegate.waitUntilUnblocked(current.cellId, blockerSignal); }
			catch (error) {
				if (yieldSignal?.aborted && !signal?.aborted) return current;
				throw error;
			}
			current = await this.cellOperation(
				current.cellId,
				context,
				signal,
				{
					method: "session/wait",
					sessionId: this.id,
					request: { cell_id: current.cellId, yield_time_ms: yieldTimeMs },
				},
				"Code-mode host returned an invalid wait outcome",
				preempt,
			);
		}
		return current;
	}

	/** Run one session/wait or session/terminate request against the host cell. */
	private async cellOperation(
		cellId: string,
		context: ToolExecutionContext,
		signal: AbortSignal | undefined,
		request: Record<string, unknown>,
		invalidOutcomeMessage: string,
		preempt?: AbortSignal,
	): Promise<RuntimeResponse> {
		throwIfAborted(signal);
		await this.start(signal);
		throwIfAborted(signal);
		this.delegate.updateCellContext(cellId, context);
		const id = this.connection.nextRequestId();
		const abort = () => { cancelOperation(this.connection, id); };
		let stopYield = () => {};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const pending = this.connection.requestWithId(id, request, (response) =>
				this.bindCell(response, context),
			);
			stopYield = this.observeYield(id, preempt);
			const value = await pending;
			const wrapped = runtimeOutcome(value);
			if (!wrapped) throw new Error(invalidOutcomeMessage);
			return {
				...this.delegate.attach(parseRuntimeResponse(wrapped)),
				...(isMissingRuntimeOutcome(value) ? { missingCell: true as const } : {}),
			};
		} finally {
			stopYield();
			signal?.removeEventListener("abort", abort);
		}
	}

	private observeYield(id: number, signal?: AbortSignal): () => void {
		const yieldNow = () => this.connection.yieldObservation(id);
		if (signal?.aborted) yieldNow();
		else signal?.addEventListener("abort", yieldNow, { once: true });
		return () => signal?.removeEventListener("abort", yieldNow);
	}

	/** Bind a host-reported cell to its execution context before replies arrive. */
	private bindCell(
		value: unknown,
		context?: ToolExecutionContext,
		tools?: Map<string, CodeModeToolDefinition>,
	): void {
		const cellId = executionCellId(value);
		if (cellId && context) this.delegate.bindCell(cellId, context, tools);
	}

	private handleMessage(message: HostMessage): void {
		if (message.type === "delegate/request") {
			this.delegate.handleRequest(message);
			return;
		}
		if (message.type === "delegate/cancel") {
			this.delegate.cancel(message.id);
			return;
		}
		if (message.type === "cell/closed") this.delegate.closeCell(message.cellId);
	}
}

function shutdownDeadline(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}
