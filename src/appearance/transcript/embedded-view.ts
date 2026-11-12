import { getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, VStack, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { embeddedHost, type EmbeddedTui } from "./embedded-host.ts";
import { EmbeddedTerminal } from "./embedded-terminal.ts";
import type { EmbeddedPresentation } from "./embedded.ts";

/** Native layout primitives, without reserving an editor dock in readonly views. */
export function createEmbeddedViewport(options: { document: Component; footer: Component; editor?: Component }) {
  if (options.editor) return embeddedHost().createChatViewport({
    ...options, editor: options.editor, pendingMessages: new Container(), status: new Container(),
  });
  const transcript = new ScrollView(options.document, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
  return { transcript, root: new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: options.footer, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]) };
}

/** One native input/render/selection owner per popup, never a second physical terminal. */
export class EmbeddedView {
  readonly tui: EmbeddedTui;
  private readonly terminal: EmbeddedTerminal;
  private root?: Component;
  private presentation?: EmbeddedPresentation;
  private releasePresentation?: () => void;
  private pressed?: TuiMouseEvent;
  private started = false;

  constructor(parent: TUI, settings: SettingsManager) {
    this.terminal = new EmbeddedTerminal(parent.terminal.kittyProtocolActive ?? false, () => parent.requestRender());
    this.tui = embeddedHost().createTui({
      tuiMode: "fullscreen", embedded: true, terminal: this.terminal, logDirectory: getAgentDir(),
      showHardwareCursor: settings.getShowHardwareCursor(),
      fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
      fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
    });
  }

  setRoot(root: Component, presentation?: EmbeddedPresentation): void {
    if (root === this.root && presentation === this.presentation) return;
    this.releasePresentation?.();
    this.releasePresentation = undefined;
    this.clearInteraction();
    if (root !== this.root) { this.root = root; this.tui.setLayoutRoot(root); }
    if (!this.started) { this.started = true; this.tui.start(); }
    this.presentation = presentation;
    this.releasePresentation = presentation?.attachTui(this.tui, root);
  }

  clearInteraction(): void {
    if (this.pressed) this.tui.handleEmbeddedMouse({ ...this.pressed, type: "release", x: -1, y: -1 });
    this.pressed = undefined;
    this.tui.resetTextSelection();
  }

  get hasPointerCapture(): boolean { return this.pressed !== undefined; }

  input(data: string): void { this.terminal.input(data); }

  handleMouse(event: TuiMouseEvent): void {
    if (event.type === "press") this.pressed = event;
    this.tui.handleEmbeddedMouse(event);
    if (event.type === "release") this.pressed = undefined;
  }

  render(width: number, height: number): string[] {
    if (width <= 0 || height <= 0) { this.clearInteraction(); return []; }
    this.terminal.resize(width, height);
    return this.terminal.frame(() => this.tui.renderEmbeddedFrame());
  }

  dispose(): void {
    this.clearInteraction();
    this.releasePresentation?.();
    this.releasePresentation = undefined; this.presentation = undefined;
    if (this.started) this.tui.stop();
    this.started = false; this.root = undefined;
  }
}
