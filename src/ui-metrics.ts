// ONE monotonic interaction clock per user-visible interaction.
// Pi semantics (verified v0.85.1): `agent_end` fires when ONE underlying run
// finishes, but auto-retry / auto-compaction / queued follow-ups may start the
// next `agent_start` afterwards; only `agent_settled` finalizes. So the clock
// opens on the FIRST agent_start of a chain and never resets mid-chain. Date
// is used only for wall-clock stamps persisted in the summary entry.

export type ActivityPhase =
  | "idle"
  | "working"
  | "thinking"
  | "writing"
  | "waiting-for-input";

export interface ThinkingInterval {
  startMs: number;
  endMs: number | undefined; // undefined = still open
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface InteractionSnapshot {
  active: boolean;
  phase: ActivityPhase;
  startedAt: number | undefined; // wall clock ms (persisted)
  elapsedMs: number; // monotonic elapsed for the ACTIVE interaction
  thinkingMs: number; // union of intervals
  thinkingOpen: boolean;
  usage: UsageTotals;
}

export interface UiMetricsCallbacks {
  /** Called on every phase/second change while an interaction is active. */
  onTick?: (snapshot: InteractionSnapshot) => void;
  /** Called once when the interaction settles (agent_settled). */
  onSettled?: (snapshot: InteractionSnapshot) => void;
}

export interface UiMetricsOptions {
  now: () => number; // monotonic
  wall: () => number; // wall clock
  tickMs?: number;
}

const OPEN_END = undefined;

/** Union of possibly-overlapping closed intervals, in ms. */
function unionMs(intervals: ThinkingInterval[], nowMs: number): number {
  const closed = intervals
    .map((i) => ({ start: i.startMs, end: i.endMs === OPEN_END ? nowMs : i.endMs }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const interval of closed) {
    if (interval.start > cursor) {
      total += interval.end - interval.start;
      cursor = interval.end;
    } else if (interval.end > cursor) {
      total += interval.end - cursor;
      cursor = interval.end;
    }
  }
  return total;
}

export class UiMetrics {
  readonly #opts: UiMetricsOptions;
  readonly #cb: UiMetricsCallbacks;
  #timer: ReturnType<typeof setInterval> | undefined;
  #generation = 0;

  #interactionStart: number | undefined;
  #interactionStartWall: number | undefined;
  #phase: ActivityPhase = "idle";
  #phaseSince = 0;
  #thinking: ThinkingInterval[] = [];
  #usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  #usageRequests = new Set<string>();

  constructor(opts: UiMetricsOptions, cb: UiMetricsCallbacks = {}) {
    this.#opts = opts;
    this.#cb = cb;
  }

  get active(): boolean {
    return this.#interactionStart !== undefined;
  }

  /** agent_start: open the interaction on the FIRST start of a chain; later
   * starts inside the same chain keep the original clock. */
  agentStart(): void {
    if (this.#interactionStart === undefined) {
      this.#interactionStart = this.#opts.now();
      this.#interactionStartWall = this.#opts.wall();
      this.#thinking = [];
      this.#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      this.#usageRequests.clear();
      this.#generation += 1;
    }
    this.setPhase("working");
    this.#ensureTicker();
  }

  /** agent_end: ONE run finished, but the chain may auto-continue (retry,
   * compaction, queued follow-ups). Close open thinking but KEEP the
   * interaction clock running — only agent_settled finalizes the interaction. */
  agentEnd(): void {
    if (!this.active) return;
    const open = this.#thinking.at(-1);
    if (open && open.endMs === OPEN_END) open.endMs = this.#opts.now();
    // Phase stays "working" across the gap; the next agent_start re-emits.
  }

  /** agent_settled: nothing will auto-continue. Close the interaction. */
  agentSettled(): void {
    if (this.#interactionStart === undefined) return;
    const open = this.#thinking.at(-1);
    if (open && open.endMs === OPEN_END) open.endMs = this.#opts.now();
    this.setPhase("idle");
    const snapshot = this.snapshot();
    this.#stopTicker();
    this.#interactionStart = undefined;
    this.#interactionStartWall = undefined;
    this.#cb.onSettled?.(snapshot);
  }

  /** session shutdown / reload: drop everything WITHOUT a settled summary. */
  reset(): void {
    this.#stopTicker();
    this.#interactionStart = undefined;
    this.#interactionStartWall = undefined;
    this.#phase = "idle";
    this.#thinking = [];
    this.#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.#usageRequests.clear();
    this.#generation += 1;
  }

  get generation(): number {
    return this.#generation;
  }

  setPhase(phase: ActivityPhase): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.#phaseSince = this.#opts.now();
    this.#emit();
  }

  /** tool_execution_start: tools run while the interaction is working. */
  toolStart(): void {
    if (this.active && this.#phase !== "waiting-for-input") this.setPhase("working");
  }

  /** write args streaming detected (toolCall blocks in a message_update). */
  writeStreaming(): void {
    if (this.active && this.#phase !== "waiting-for-input") this.setPhase("writing");
  }

  thinkingStart(): void {
    if (!this.active) return;
    const open = this.#thinking.at(-1);
    if (open && open.endMs === OPEN_END) return; // already open — deltas don't restart
    this.#thinking.push({ startMs: this.#opts.now(), endMs: OPEN_END });
    this.setPhase("thinking");
  }

  /** Real thinking_end OR a conservative phase transition (text/toolcall). */
  thinkingEnd(): void {
    const open = this.#thinking.at(-1);
    if (open && open.endMs === OPEN_END) open.endMs = this.#opts.now();
    if (this.#phase === "thinking") this.setPhase("working");
  }

  /** ui_prompt_start — native dialogs/permission prompts/ask-user. */
  uiPromptStart(): void {
    if (this.active) this.setPhase("waiting-for-input");
  }

  uiPromptEnd(): void {
    if (this.active && this.#phase === "waiting-for-input") this.setPhase("working");
  }

  /** Record usage for a completed request. `requestKey` must identify the
   * request/message so replays and duplicate completions don't double-count.
   * Unknown (unidentifiable) usage is attributed conservatively ONLY when
   * `identified` is true. */
  recordUsage(requestKey: string, usage: Partial<UsageTotals>, identified = true): void {
    if (!this.active) return;
    if (identified) {
      if (this.#usageRequests.has(requestKey)) return;
      this.#usageRequests.add(requestKey);
    }
    this.#usage.input += Math.max(0, usage.input ?? 0);
    this.#usage.output += Math.max(0, usage.output ?? 0);
    this.#usage.cacheRead += Math.max(0, usage.cacheRead ?? 0);
    this.#usage.cacheWrite += Math.max(0, usage.cacheWrite ?? 0);
  }

  snapshot(): InteractionSnapshot {
    const nowMs = this.#opts.now();
    const open = this.#thinking.at(-1);
    const thinkingOpen = open !== undefined && open.endMs === OPEN_END;
    return {
      active: this.active,
      phase: this.#phase,
      startedAt: this.#interactionStartWall,
      elapsedMs: this.active ? Math.max(0, nowMs - this.#interactionStart!) : 0,
      thinkingMs: unionMs(this.#thinking, nowMs),
      thinkingOpen,
      usage: { ...this.#usage },
    };
  }

  #ensureTicker(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.#emit(), this.#opts.tickMs ?? 1000);
    // Unref so a stuck timer can't hold the process open.
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  #stopTicker(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #emit(): void {
    if (!this.active) return;
    this.#cb.onTick?.(this.snapshot());
  }

  /** Test/diagnostic hook: the ticker must be gone after settle/reset. */
  get tickerAlive(): boolean {
    return this.#timer !== undefined;
  }

  /** Test hook: force a synchronous tick emission (the real ticker uses the
   * wall clock; tests advance a fake clock and call this). */
  tickNow(): void {
    this.#emit();
  }
}

/** Codex duration grammar: "38s" / "1m 08s" / "1h 02m 03s" (leading-zero
 * minutes/seconds in compound forms, matching the reference's `1m 08s`). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Codex compact tokens: 143000 → "143k", 9200 → "9.2k". */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const value = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
    return `${value}k`;
  }
  return String(Math.round(tokens));
}

export const WORKING_PHASE_LABEL: Record<ActivityPhase, string> = {
  idle: "Working",
  working: "Working",
  thinking: "Thinking",
  writing: "Writing",
  "waiting-for-input": "Waiting for input",
};
