// Probe Pi's public UI capabilities. Installation and restoration belong
// to the extension lifecycle; this module only reports the available surface.

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

type UiMode = string;

export interface HostFacts {
  mode: UiMode;
  hasUI: boolean;
  isTui: boolean;
  /** Which public UI methods actually exist on ctx.ui. */
  available: Partial<Record<keyof UiSurface, boolean>>;
  agentDir: string | undefined;
}

interface UiSurfaceInput {
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
