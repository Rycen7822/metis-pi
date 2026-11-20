const TRACE_KINDS = new Map<string, string>([
  ["response.created", "created"], ["response.in_progress", "in_progress"],
  ["response.output_item.added", "item.added"], ["response.output_item.done", "item.done"],
  ["response.function_call_arguments.delta", "args.delta"], ["response.custom_tool_call_input.delta", "args.delta"],
  ["response.function_call_arguments.done", "args.done"], ["response.custom_tool_call_input.done", "args.done"],
  ["response.output_text.delta", "text.delta"], ["response.reasoning_summary_text.delta", "reasoning.delta"],
  ["response.completed", "completed"], ["response.incomplete", "incomplete"], ["response.failed", "failed"], ["error", "error"],
]);
const MILESTONES = new Set(["created", "item.added", "item.done", "args.done", "completed", "incomplete", "failed", "error"]);
const ITEM_KINDS = new Set(["function_call", "custom_tool_call", "reasoning", "message"]);
const MAX_TRACES = 4;
const MAX_MILESTONES = 12;

type Outcome = "live" | "done" | "cancelled" | "argument timeout" | "error";
type Mark = { time: number; kind: string; index?: number; item?: string };

class ResponsesTrace {
  private readonly start = performance.now();
  private readonly milestones: Mark[] = [];
  private last?: Mark;
  private count = 0;
  private argBytes = 0;
  private lastArgs?: Mark;
  private outcome: Outcome = "live";
  private finishedAt?: number;

  observe(event: unknown): void {
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") return;
    const kind = TRACE_KINDS.get(event.type) ?? "other";
    const index = "output_index" in event && typeof event.output_index === "number" && Number.isSafeInteger(event.output_index)
      ? event.output_index : undefined;
    const item = "item" in event && event.item && typeof event.item === "object" && "type" in event.item
      && typeof event.item.type === "string" && ITEM_KINDS.has(event.item.type) ? event.item.type : undefined;
    this.count++;
    const mark = this.last = { time: this.elapsed(), kind, index, item };
    if (kind === "args.delta" && "delta" in event && typeof event.delta === "string" && event.delta.length) {
      this.argBytes += Buffer.byteLength(event.delta);
      this.lastArgs = mark;
    }
    if (MILESTONES.has(kind)) {
      this.milestones.push(mark);
      if (this.milestones.length > MAX_MILESTONES) this.milestones.shift();
    }
  }

  finish(outcome: Exclude<Outcome, "live">): void {
    this.outcome = outcome;
    this.finishedAt = this.elapsed();
  }

  private elapsed(): number { return Math.round(performance.now() - this.start); }

  report(): string[] {
    const mark = ({ time, index, kind, item }: Mark) => `${kind}${index === undefined ? "" : ` #${index}`}${item ? ` ${item}` : ""} +${time}ms`;
    return [
      `${this.outcome} after ${this.finishedAt ?? this.elapsed()}ms; ${this.count} parsed events; ${this.argBytes} argument delta bytes`,
      `  Last event: ${this.last ? mark(this.last) : "none"}; last argument progress: ${this.lastArgs ? mark(this.lastArgs) : "none"}`,
      ...(this.milestones.length ? [`  Milestones: ${this.milestones.map(mark).join(" → ")}`] : []),
    ];
  }
}

/** Owning command discards the window at session boundaries; active requests may finish without republishing it. */
export function createResponsesDiagnostics() {
  let traces: ResponsesTrace[] | undefined;
  return {
    enable() { traces ??= []; },
    disable() { traces = undefined; },
    reset() { if (traces) traces = []; },
    begin() {
      if (!traces) return;
      const trace = new ResponsesTrace();
      traces.push(trace);
      if (traces.length > MAX_TRACES) traces.shift();
      return trace;
    },
    status(): string {
      if (!traces) return "Responses stream diagnostics off. Use /responses-stream on before reproducing.";
      if (!traces.length) return "Responses stream diagnostics on. No OpenAI HTTP Responses request captured yet.";
      return ["OpenAI HTTP Responses · recent requests, oldest first", ...traces.flatMap(trace => trace.report())].join("\n");
    },
  };
}

export type BeginResponsesTrace = ReturnType<typeof createResponsesDiagnostics>["begin"];
