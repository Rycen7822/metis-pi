import * as Core from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";

export interface EmbeddedTui extends Tui.TuiAltScreen {
  renderEmbeddedFrame(): string[];
  handleEmbeddedMouse(event: Tui.TuiMouseEvent): void;
}

interface EmbeddedCore {
  getEditorTheme(): Tui.EditorTheme;
  createChatViewport(options: {
    document: Tui.Component; pendingMessages: Tui.Component; status: Tui.Component;
    editor: Tui.Component; footer: Tui.Component;
  }): { root: Tui.Component; transcript: Tui.ScrollView };
  withBuiltInRenderers(name: string, definition: Core.ToolRenderers | undefined): Core.ToolRenderers | undefined;
  createInteractiveTui(options: {
    tuiMode: "fullscreen"; embedded: true; terminal: Tui.Terminal; showHardwareCursor: boolean; logDirectory: string;
    fullscreenCopyOnSelect: boolean; fullscreenWheelScrollLines: Tui.WheelScrollLines;
  }): Tui.TuiAltScreen;
}

/** Stock 1.5.2 types lack these Metis exports; require the patched runtime before use. */
export function embeddedHost() {
  const core = Core as typeof Core & Partial<EmbeddedCore>;
  const { createChatViewport, withBuiltInRenderers, getEditorTheme, createInteractiveTui } = core;
  if (typeof createChatViewport !== "function" || typeof withBuiltInRenderers !== "function" || typeof getEditorTheme !== "function"
    || typeof createInteractiveTui !== "function"
    || ["renderEmbeddedFrame", "handleEmbeddedMouse"].some(name => typeof Reflect.get(Tui.TuiAltScreen.prototype, name) !== "function")) {
    throw new Error("BTW requires the current Metis SDK patches for Pi 1.5.2. Finish updating Metis and fully restart Pi.");
  }
  return {
    createChatViewport, withBuiltInRenderers, getEditorTheme,
    createTui: (options: Parameters<EmbeddedCore["createInteractiveTui"]>[0]) => createInteractiveTui(options) as EmbeddedTui,
  };
}
