import { createAssistantMessageEventStream, type Api, type AssistantMessage,
  type AssistantMessageEventStream, type Model, type Provider } from "@earendil-works/pi-ai";
import type { BeginResponsesTrace } from "./responses-trace.ts";

const TOOL_ARGUMENT_IDLE_MS = 120_000;

function trackToolArguments(idleMs: number, expire: () => void) {
  const deadlines = new Map<number, number>(); // Responses output_index, not Pi's content index.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    clearTimeout(timer);
    timer = undefined;
    deadlines.clear();
  }
  function checkIdle() {
    timer = undefined;
    const now = performance.now();
    let earliest = Infinity;
    for (const deadline of deadlines.values()) earliest = Math.min(earliest, deadline);
    if (earliest <= now) expire();
    else if (earliest !== Infinity) timer = setTimeout(checkIdle, Math.ceil(earliest - now)).unref();
  }
  function observe(event: unknown) {
    if (!event || typeof event !== "object" || !("type" in event)) return;
    const { type } = event;
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error") {
      clear();
      return;
    }
    if (!("output_index" in event) || typeof event.output_index !== "number") return;
    const index = event.output_index;
    if (type === "response.function_call_arguments.done" || type === "response.custom_tool_call_input.done"
        || type === "response.output_item.done") {
      deadlines.delete(index);
      if (!deadlines.size) clear();
      return;
    }
    // A tool announcement with empty input is not evidence that args have started streaming.
    let chunk: unknown;
    if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
      if ("delta" in event) chunk = event.delta;
    } else if (type === "response.output_item.added" && "item" in event) {
      const item = event.item;
      if (item && typeof item === "object" && "type" in item) {
        if (item.type === "function_call" && "arguments" in item) chunk = item.arguments;
        if (item.type === "custom_tool_call" && "input" in item) chunk = item.input;
      }
    }
    if (typeof chunk !== "string" || !chunk.length) return;
    deadlines.set(index, performance.now() + idleMs);
    timer ??= setTimeout(checkIdle, idleMs).unref();
  }
  return { observe, clear };
}

function watchProgress(
  model: Model<Api>,
  signal: AbortSignal | undefined,
  start: (signal: AbortSignal, observe: (event: unknown) => void) => AssistantMessageEventStream,
  idleMs: number,
  trace: ReturnType<BeginResponsesTrace>,
): AssistantMessageEventStream {
  const deadline = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const output = createAssistantMessageEventStream();
  const progress = trackToolArguments(idleMs, () => deadline.abort());
  async function forward() {
    let partial: AssistantMessage | undefined;
    let result: AssistantMessage | undefined;
    try {
      const source = start(requestSignal, event => {
        if (requestSignal.aborted) return;
        trace?.observe(event);
        progress.observe(event);
      });
      for await (const event of source) {
        if ((event.type === "error" || event.type === "done") && deadline.signal.aborted && !signal?.aborted) {
          // Native Responses returns "aborted" for our local abort, but a
          // stalled request is an error, not a cancellation by the user.
          const error: AssistantMessage = {
            ...(event.type === "error" ? event.error : event.message), stopReason: "error",
            errorMessage: `OpenAI Responses stream stalled: unfinished tool arguments made no progress for ${idleMs / 1000}s.`,
          };
          trace?.finish("argument timeout");
          output.push({ type: "error", reason: "error", error });
          return;
        }
        if ("partial" in event) partial = event.partial;
        if (event.type === "done" || event.type === "error") {
          progress.clear();
          trace?.finish(event.type === "done" ? "done" : event.reason === "aborted" ? "cancelled" : "error");
        }
        output.push(event);
      }
      result = await source.result();
    } catch (cause) {
      deadline.abort();
      const reason = signal?.aborted ? "aborted" : "error";
      trace?.finish(reason === "aborted" ? "cancelled" : "error");
      const error: AssistantMessage = {
        ...(partial ?? { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
        stopReason: reason, errorMessage: cause instanceof Error ? cause.message : String(cause),
      };
      output.push({ type: "error", reason, error });
    } finally {
      progress.clear();
      output.end(result);
    }
  }
  void forward();
  return output;
}

export function withResponsesProgress(base: Provider, idleMs = TOOL_ARGUMENT_IDLE_MS, beginTrace?: BeginResponsesTrace): Provider {
  return {
    ...base,
    streamSimple(model, context, options) {
      if (model.api !== "openai-responses") return base.streamSimple(model, context, options);
      return watchProgress(model, options?.signal, (signal, observe) => base.streamSimple(model, context, {
        ...options, signal,
        onProviderStreamEvent(event, requestModel) {
          observe(event);
          return options?.onProviderStreamEvent?.(event, requestModel);
        },
      }), idleMs, beginTrace?.());
    },
  };
}
