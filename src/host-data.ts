// Narrow, explicit bridge from Pi's real ExtensionContext to this extension's
// stable display snapshot. Verified against Pi v0.85.1 types:
//   ctx.model: {id, name, provider, contextWindow} | undefined
//   ctx.thinkingLevel: ThinkingLevel | undefined   ("off" is a real level)
//   ctx.getContextUsage(): {tokens, contextWindow, percent} | undefined
//   ctx.cwd, ctx.mode ("tui" guards all chrome)
// All reads go through the LIVE context: its getters stay dynamic, so a
// model/effort switch shows up without a restart. Values are validated at the
// boundary — no unknown/as-any escape, invalid pieces degrade to "unknown".

export interface ModelSnapshot {
  /** Real model id (always present on a valid host model). */
  id: string;
  /** Optional display name; id remains the default display. */
  name?: string;
  /** Real provider id (kept verbatim when no display name is known). */
  provider?: string;
  contextWindow?: number;
}

export interface ContextUsageSnapshot {
  /** Estimated context tokens, or null when the host reports unknown. */
  tokens: number | null;
  contextWindow: number;
  /** 0..100, or null when tokens is unknown. */
  percent: number | null;
}

/** Structural subset of the real ExtensionContext. Shape-verified against the
 * host types by host-smoke; tests inject the same structural fakes. */
export interface HostContextLike {
  mode?: string;
  hasUI?: boolean;
  cwd?: string;
  model?: unknown;
  thinkingLevel?: unknown;
  getContextUsage?: () => unknown;
  sessionManager?: { getEntries?: () => unknown[] };
  ui?: Record<string, unknown>;
}

/** The public UI surface we rely on (verified against Pi v0.85.1 types). */
export interface UiSurface {
  setEditorComponent: (factory: unknown) => void;
  getEditorComponent: () => unknown;
  setFooter: (factory: unknown) => void;
  setHeader: (factory: unknown) => void;
  setWidget: (key: string, content: unknown, options?: unknown) => void;
  setWorkingMessage: (message?: string) => void;
  setWorkingVisible: (visible: boolean) => void;
  setWorkingIndicator: (options?: unknown) => void;
  setStatus: (key: string, text: string | undefined) => void;
}

/** Which members of UiSurface the LIVE ctx.ui actually provides. */
export type UiAvailable = Partial<Record<keyof UiSurface, boolean>>;

const UI_SURFACE_METHODS: ReadonlyArray<keyof UiSurface> = [
  "setEditorComponent", "getEditorComponent", "setFooter", "setHeader",
  "setWidget", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setStatus",
];

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate a raw host model object into the display shape. Returns undefined
 * when no usable id exists (a model without id is not displayable). */
export function toModelSnapshot(model: unknown): ModelSnapshot | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record = model as Record<string, unknown>;
  const id = nonEmptyString(record.id);
  if (!id) return undefined;
  const snapshot: ModelSnapshot = { id };
  const name = nonEmptyString(record.name);
  if (name) snapshot.name = name;
  const provider = nonEmptyString(record.provider);
  if (provider) snapshot.provider = provider;
  const contextWindow = finiteNumber(record.contextWindow);
  if (contextWindow !== undefined && contextWindow > 0) snapshot.contextWindow = contextWindow;
  return snapshot;
}

/** Validate a raw ContextUsage. Missing/invalid pieces become null, never NaN. */
export function toContextUsageSnapshot(raw: unknown): ContextUsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const contextWindow = finiteNumber(record.contextWindow);
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  const tokensRaw = record.tokens;
  const tokens = tokensRaw === null || tokensRaw === undefined ? null : finiteNumber(tokensRaw);
  const percentRaw = record.percent;
  let percent = percentRaw === null || percentRaw === undefined ? null : finiteNumber(percentRaw);
  if (percent !== undefined && percent !== null && (percent < 0 || percent > 100)) percent = null;
  return { tokens: tokens ?? null, contextWindow, percent: percent ?? null };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class HostData {
  #ctx: HostContextLike | undefined;
  #revision = 0;

  /** Bind the live context (session_start) or clear it (shutdown). */
  bind(ctx: HostContextLike | undefined): void {
    this.#ctx = ctx;
    this.#revision += 1;
  }

  /** Model/effort/context-impacting events bump the revision so a single
   * refresh never mixes a new model's window with an old model's percent. */
  bump(): void {
    this.#revision += 1;
  }

  get revision(): number {
    return this.#revision;
  }

  get bound(): boolean {
    return this.#ctx !== undefined;
  }

  get mode(): string {
    return typeof this.#ctx?.mode === "string" ? this.#ctx.mode : "unknown";
  }

  get hasUI(): boolean {
    return this.#ctx?.hasUI === true;
  }

  /** True only for the real TUI process; print/json/rpc never get chrome. */
  get isTui(): boolean {
    return this.mode === "tui";
  }

  /**
   * Probe the LIVE ctx.ui once per call and report which methods exist. The
   * caller snapshots this at session_start and passes it down, so a mid-install
   * re-bind cannot make the availability answer disagree with the ui handle
   * that was captured next to it. Reading a method off ctx.ui cannot throw.
   */
  get available(): UiAvailable {
    const ui = this.ui as Partial<UiSurface>;
    const available: UiAvailable = {};
    for (const method of UI_SURFACE_METHODS) available[method] = typeof ui[method] === "function";
    return available;
  }

  /** Read the model through the LIVE context (never a session_start copy). */
  getModel(): ModelSnapshot | undefined {
    return toModelSnapshot(this.#ctx?.model);
  }

  /** Current thinking level; "off" is a valid, explicitly shown level. */
  getThinkingLevel(): string | undefined {
    const level = this.#ctx?.thinkingLevel;
    return typeof level === "string" && THINKING_LEVELS.has(level) ? level : undefined;
  }

  getContextUsage(): ContextUsageSnapshot | undefined {
    const read = this.#ctx?.getContextUsage;
    if (typeof read !== "function") return undefined;
    try {
      return toContextUsageSnapshot(read.call(this.#ctx));
    } catch {
      return undefined;
    }
  }

  getCwd(): string {
    return typeof this.#ctx?.cwd === "string" ? this.#ctx.cwd : "";
  }

  /** Whether the live context exposes sessionManager.getEntries (footer
   * shows Σ only when the source truly exists — no fabricated zeros). */
  get hasSessionManager(): boolean {
    return typeof this.#ctx?.sessionManager?.getEntries === "function";
  }

  /** Live UI surface record (empty object when unbound). */
  get ui(): Record<string, unknown> {
    return this.#ctx?.ui ?? {};
  }

  /** Session entries for the session-scope usage ledger (bounded reads only
   * on init/restore/verified structure changes — never per tick/render). */
  getSessionEntries(): unknown[] {
    const manager = this.#ctx?.sessionManager;
    const read = manager?.getEntries;
    if (typeof read !== "function" || !manager) return [];
    try {
      const entries = read.call(manager);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }
}
