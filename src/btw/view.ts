import * as Core from "@earendil-works/pi-coding-agent";
import {
  Container, MouseRegion, Text, VStack, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EmbeddedTranscript } from "../appearance/transcript/embedded.ts";
import type { TranscriptSurface } from "../appearance/transcript/surface.ts";
import { ConversationDocument } from "../appearance/transcript/document.ts";
import { TOOL_NAMES } from "../presentation/tool-names.ts";
import { embeddedHost } from "../appearance/transcript/embedded-host.ts";
import { EmbeddedView } from "../appearance/transcript/embedded-view.ts";
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
  private readonly embedded: EmbeddedView;
  private readonly editor: Core.CustomEditor;
  private readonly root: VStack;
  private readonly releaseEditor?: () => void;
  private sessionView?: BtwSessionView;
  private transcript?: ConversationDocument;
  private active = false;
  private modeX = 0;
  private closeX = 0;

  constructor(private readonly options: BtwViewOptions) {
    const { tui: parent, theme, keybindings, settings } = options;
    this.embedded = new EmbeddedView(parent, settings);
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
    this.embedded.setRoot(this.root);
    this.tui.setFocus(this.editor);
  }

  private get tui() { return this.embedded.tui; }

  get focused(): boolean { return this.active; }
  set focused(value: boolean) {
    this.active = value;
    const target = this.tui.getFocusedComponent();
    if (target && "focused" in target) target.focused = value;
  }

  setSession(view: BtwSessionView | undefined): void {
    if (this.sessionView === view) return;
    this.transcript?.dispose();
    this.transcript = undefined;
    this.sessionView = view;
    this.embedded.clearInteraction();
    this.embedded.setRoot(this.root, view?.presentation);
    if (view) {
      this.transcript = new ConversationDocument(this.document, {
        ui: this.tui, settings: view.session.settingsManager, state: view.surface.transcript,
        cwd: view.session.sessionManager.getCwd(), timestamps: view.presentation !== undefined,
        resolveTool: name => {
          const native = this.host.withBuiltInRenderers(name, view.session.getToolDefinition(name));
          const known = TOOL_NAMES.find(tool => tool === name), renderer = known && view.presentation?.renderers[known];
          return renderer ? { ...native, ...renderer } : native;
        },
      });
      for (const message of view.messages) this.transcript.append(message);
      if (view.partial) this.transcript.handleEvent({ type: "message_start", message: view.partial });
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
    else this.embedded.input(data);
  }

  handleMouse(event: TuiMouseEvent) {
    this.embedded.handleMouse(event);
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
    return this.embedded.render(width, height);
  }

  dispose(): void {
    this.embedded.dispose();
    this.releaseEditor?.();
    this.transcript?.dispose();
    this.transcript = undefined;
  }
}
