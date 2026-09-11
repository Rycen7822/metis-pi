// host-compat.ts — the single place that touches Pi's public UI surface and
// reports what is actually available/applied. TUI-only guards live here.
//
// Principle: public APIs first (ctx.ui.*), factory-identity checks for
// restore, no getters invented where the host doesn't expose them, and a
// capability matrix for /codex-ui status.

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

export type UiMode = string;

export interface HostFacts {
  mode: UiMode;
  hasUI: boolean;
  isTui: boolean;
  /** Which public UI methods actually exist on ctx.ui. */
  available: Partial<Record<keyof UiSurface, boolean>>;
  agentDir: string | undefined;
}

export interface UiSurfaceInput {
  ui: Partial<UiSurface>;
  mode: UiMode;
  hasUI: boolean;
  agentDir?: string;
}

export function probeHost(input: UiSurfaceInput): HostFacts {
  const ui = input.ui ?? {};
  const methods: Array<keyof UiSurface> = [
    "setEditorComponent", "getEditorComponent", "setFooter", "setHeader",
    "setWidget", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setStatus",
  ];
  const available: Partial<Record<keyof UiSurface, boolean>> = {};
  for (const m of methods) available[m] = typeof ui[m] === "function";
  return {
    mode: input.mode,
    hasUI: input.hasUI === true,
    isTui: input.mode === "tui",
    available,
    agentDir: input.agentDir,
  };
}

/** Terminal-only features must be gated on the REAL TUI mode, not hasUI. */
export function allowsChrome(facts: HostFacts): boolean {
  return facts.isTui;
}

/** A slot that was set through a public API, tracked by factory identity so
 * restore only removes OUR factory (never a successor's). */
export class UiSlot<T> {
  readonly #name: string;
  #ours: T | undefined;
  #active = false;
  #set: (factory: T | undefined) => void;
  #diagnostics: string[] = [];

  constructor(name: string, set: (factory: T | undefined) => void) {
    this.#name = name;
    this.#set = set;
  }

  /** Install our factory. Reports (never overwrites silently) when a foreign
   * factory is already active — we still take over (last installer wins per
   * Pi semantics) but the status panel shows the takeover. */
  install(factory: T, previous: unknown): void {
    this.#ours = factory;
    this.#set(factory);
    this.#active = true;
    if (previous !== undefined && previous !== null) {
      this.#diagnostics.push(`slot ${this.#name}: previous factory replaced by ${this.#name} owner`);
    }
  }

  /** Restore only when OUR factory is still the live one. The host has no
   * getter for every slot, so identity is checked where available and the
   * owner is cleared unconditionally only when no getter exists. */
  restore(current: unknown, unset: () => void): void {
    if (!this.#active) return;
    if (current !== undefined && current !== this.#ours) {
      // A successor took over after us: leave theirs untouched.
      this.#active = false;
      this.#ours = undefined;
      this.#diagnostics.push(`slot ${this.#name}: successor holds the slot; restore skipped`);
      return;
    }
    try {
      unset();
    } finally {
      this.#active = false;
      this.#ours = undefined;
    }
  }

  get isActive(): boolean {
    return this.#active;
  }
  get name(): string {
    return this.#name;
  }
  get diagnostics(): readonly string[] {
    return this.#diagnostics;
  }
}

/** Counters surfaced by /codex-ui status (leak detection). */
export class ResourceCounters {
  timers = 0;
  subscriptions = 0;
  widgets = 0;
  pendingBounded = 0;

  snapshot(): Record<string, number> {
    return {
      timers: this.timers,
      subscriptions: this.subscriptions,
      widgets: this.widgets,
      pendingBounded: this.pendingBounded,
    };
  }
}
