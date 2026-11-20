import * as Core from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

export type EmbeddedTui = TuiAltScreen;

export function embeddedHost() {
  // The official Pi 1.6.0 can load Metis before the first patched restart.
  const { createChatViewport, withBuiltInRenderers, getEditorTheme, createInteractiveTui } = Core;
  const required = [createChatViewport, withBuiltInRenderers, getEditorTheme, createInteractiveTui,
    TuiAltScreen.prototype.renderEmbeddedFrame, TuiAltScreen.prototype.handleEmbeddedMouse];
  if (required.some(method => typeof method !== "function")) {
    throw new Error("Embedded views require the patched Pi 1.6.0 SDK. Finish updating Metis and fully restart Pi.");
  }
  return {
    createChatViewport, withBuiltInRenderers, getEditorTheme,
    createTui: (options: Core.InteractiveTuiOptions & { tuiMode: "fullscreen"; embedded: true }) => createInteractiveTui(options),
  };
}
