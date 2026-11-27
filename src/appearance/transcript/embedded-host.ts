import * as Core from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { sdkVersion } from "../../pi-sdk/artifact.mjs";

export type EmbeddedTui = TuiAltScreen;

export function embeddedHost() {
  // Pi can load extensions before restarting into the patched SDK.
  const { createChatViewport, withBuiltInRenderers, getEditorTheme, createInteractiveTui } = Core;
  const required = [createChatViewport, withBuiltInRenderers, getEditorTheme, createInteractiveTui,
    TuiAltScreen.prototype.renderEmbeddedFrame, TuiAltScreen.prototype.handleEmbeddedMouse];
  if (required.some(method => typeof method !== "function")) {
    throw new Error(`Embedded views require the patched Pi ${sdkVersion} SDK. Finish updating Metis and fully restart Pi.`);
  }
  return {
    createChatViewport, withBuiltInRenderers, getEditorTheme,
    createTui: (options: Core.InteractiveTuiOptions & { tuiMode: "fullscreen"; embedded: true }) => createInteractiveTui(options),
  };
}
