import * as Core from "@earendil-works/pi-coding-agent";
import {
  Container, MouseRegion, Text, VStack, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EmbeddedTranscript } from "../appearance/transcript/embedded.ts";
import type { TranscriptSurface } from "../appearance/transcript/surface.ts";
import { BtwTranscript } from "./transcript.ts";
import { embeddedHost, type EmbeddedTui } from "./host.ts";
import { EmbeddedTerminal } from "./terminal.ts";
import type { BtwAccess } from "./access.ts";

export interface BtwSessionView {
  session: Core.AgentSession;
  surface: TranscriptSurface;
  presentation?: EmbeddedTranscript;
  messages: AgentMessage[];
  partial?: AssistantMessage;
}

interface BtwViewOptions {
  tui: TUI;
  theme: Core.Theme;
  keybindings: ConstructorParameters<typeof Core.CustomEditor>[2];
  settings: Core.SettingsManager;
  presentation?: EmbeddedTranscript;
  getAccess(): BtwAccess;
  getStatus(): string;
  onToggleAccess(): void;
  onSubmit(value: string): void;
  onDismiss(): void;
}

/** Native main renderer on a virtual terminal: no second agent UI or terminal takeover. */
export class BtwOverlay implements Component, Focusable {
  private readonly host = embeddedHost();
  private readonly document = new Container();
  private readonly header = new Text("", 0, 0);
  private readonly footer = new Text("", 0, 0);
  private readonly terminal: EmbeddedTerminal;
  private readonly tui: EmbeddedTui;
  private readonly editor: Core.CustomEditor;
  private readonly root: VStack;
  private readonly releaseEditor?: () => void;
  private sessionView?: BtwSessionView;
  private transcript?: BtwTranscript;
  private releasePresentation?: () => void;
  private active = false;
  private modeX = 0;
  private closeX = 0;

  constructor(private readonly options: BtwViewOptions) {
    const { tui: parent, theme, keybindings, settings } = options;
    this.terminal = new EmbeddedTerminal(parent.terminal.kittyProtocolActive ?? false, () => parent.requestRender());
    this.tui = this.host.createTui({
      tuiMode: "fullscreen", embedded: true, terminal: this.terminal, logDirectory: Core.getAgentDir(),
      showHardwareCursor: settings.getShowHardwareCursor(),
      fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
      fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
    });
    const styled = options.presentation?.createEditor?.(this.tui, this.host.getEditorTheme(), keybindings);
    if (styled) {
      if (!(styled.component instanceof Core.CustomEditor)) {
        styled.dispose();
        throw new Error("BTW editor factory did not return the native CustomEditor.");
      }
      this.editor = styled.component;
    } else {
      this.editor = new Core.CustomEditor(this.tui, this.host.getEditorTheme(), keybindings, {
        paddingX: settings.getEditorPaddingX(), autocompleteMaxVisible: settings.getAutocompleteMaxVisible(), embedWorkingStatus: true,
      });
    }
    this.releaseEditor = styled?.dispose;
    if (!styled) this.editor.borderColor = text => theme.fg("border", text);
    this.editor.onSubmit = text => {
      const value = text.trim();
      if (!value) return;
      this.editor.addToHistory(value);
      this.editor.setText("");
      options.onSubmit(value);
    };
    this.editor.onEscape = options.onDismiss;
    this.editor.onCtrlD = options.onDismiss;
    this.editor.onAction("app.tools.expand", () => { this.transcript?.toggleExpanded(); this.tui.requestRender(); });
    this.editor.onAction("app.thinking.toggle", () => { this.transcript?.toggleThinking(); this.tui.requestRender(); });
    if (!styled) this.editor.onExtensionShortcut = data => this.sessionView?.presentation?.copyKey?.(data, this.editor) ?? false;
    const viewport = this.host.createChatViewport({
      document: this.document, pendingMessages: new Container(), status: new Container(),
      editor: this.editor, footer: this.footer,
    });
    const header = new MouseRegion({
      render: width => { this.renderHeader(width); return this.header.render(width); },
      invalidate: () => this.header.invalidate(),
    }, event => {
      if (event.button !== "left") return;
      if (event.type === "click") {
        if (event.x >= this.closeX) options.onDismiss();
        else if (event.x >= this.modeX) options.onToggleAccess();
      }
      if (event.x >= this.modeX) return { handled: true };
    });
    this.root = new VStack([
      { component: header, basis: 1, shrink: 0 },
      { component: viewport.root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(this.root);
    this.tui.setFocus(this.editor);
    this.tui.start();
  }

  get focused(): boolean { return this.active; }
  set focused(value: boolean) {
    this.active = value;
    const target = this.tui.getFocusedComponent();
    if (target && "focused" in target) target.focused = value;
  }

  setSession(view: BtwSessionView | undefined): void {
    if (this.sessionView === view) return;
    this.transcript?.dispose();
    this.releasePresentation?.();
    this.transcript = undefined;
    this.releasePresentation = undefined;
    this.sessionView = view;
    this.document.clear();
    this.tui.resetTextSelection();
    if (view) {
      this.transcript = new BtwTranscript(this.document, view.session, view.surface, view.presentation, this.tui, view.messages, view.partial);
      this.releasePresentation = view.presentation?.attachTui(this.tui, this.root);
    }
    this.tui.requestRender();
  }

  handleEvent(event: Core.AgentSessionEvent): void { this.transcript?.handleEvent(event); this.tui.requestRender(); }
  refresh(focused: boolean): void { this.focused = focused; this.options.tui.requestRender(); }
  setInputText(text: string): void { this.editor.setText(text); }
  getInputText(): string { return this.editor.getText(); }
  invalidate(): void { this.tui.invalidate(); }

  handleInput(data: string): void {
    if (matchesKey(data, "alt+p")) this.options.onToggleAccess();
    else this.terminal.input(data);
  }

  handleMouse(event: TuiMouseEvent) {
    this.tui.handleEmbeddedMouse(event);
    return { handled: true, capture: event.type === "press" };
  }

  private renderHeader(width: number): void {
    const { theme } = this.options;
    const close = truncateToWidth("[X]", width, ""), mode = width >= 14 ? `[${this.options.getAccess()}] ` : "";
    this.modeX = width - visibleWidth(mode + close);
    this.closeX = width - visibleWidth(close);
    const title = truncateToWidth("BTW side chat", Math.max(0, this.modeX - 1), "");
    this.header.setText(theme.fg("accent", theme.bold(title)) + " ".repeat(Math.max(0, this.modeX - visibleWidth(title)))
      + theme.fg(this.options.getAccess() === "write" ? "warning" : "success", mode) + theme.fg("accent", close));
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(1, Math.floor((this.options.tui.terminal.rows || 24) * 0.7));
    const hints = ["Alt+P read/write", Core.keyHint("app.tools.expand", "tools"),
      Core.keyHint("app.thinking.toggle", "thinking"), "Esc close"].join(" · ");
    this.footer.setText(this.options.theme.fg("dim", `${this.options.getStatus()} · ${hints}`));
    this.terminal.resize(width, height);
    return this.terminal.frame(() => this.tui.renderEmbeddedFrame());
  }

  dispose(): void {
    this.tui.stop();
    this.releasePresentation?.();
    this.releasePresentation = undefined;
    this.releaseEditor?.();
    this.transcript?.dispose();
    this.transcript = undefined;
    this.document.clear();
  }
}
