import { ToolExecutionComponent, getMarkdownTheme, highlightCode, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, getCapabilities, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { makeRenderers, type ToolName } from "../renderers.ts";
import { createDiffComponent, createShellFactories } from "../chrome/tool-components.ts";
import { CodexThinkingClickableComponent, CodexThinkingPeekComponent, CodexThinkingRailComponent } from "../chrome/transcript-components.ts";
import { createThinkingViewControl, type ThinkingView } from "../thinking-view.ts";
import { thoughtSummaryText } from "../thinking-summary.ts";
import { resolveColorContext } from "../palette.ts";
import type { AppearanceConfig } from "../config.ts";
import { subagentToolRenderers } from "./rendering.ts";

export const cleanViewerText = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
export interface ViewerMessage {
  role: string;
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  errorMessage?: string;
}
const colorLevel = () => resolveColorContext({ terminalTrueColor: getCapabilities().trueColor === true });

/** The same gesture owner, peek window and rail used in the parent transcript. */
class ThinkingBlock implements Component {
  private control = createThinkingViewControl();
  private child!: Component;
  private readonly body: Markdown;
  private fallback: ThinkingView;
  private readonly theme: Theme;
  private readonly config: AppearanceConfig["thinking"];
  private readonly changed: () => void;
  constructor(text: string, theme: Theme, config: AppearanceConfig["thinking"], changed: () => void) {
    this.theme = theme; this.config = config; this.changed = changed;
    this.body = new Markdown(cleanViewerText(text), 1, 0, getMarkdownTheme(), { color: value => theme.fg("thinkingText", value), italic: true });
    this.fallback = config.completed; this.rebuild();
  }
  private rebuild() {
    const view = this.control.userView() ?? this.fallback;
    let child: Component = view === "collapsed" ? new Text(this.theme.fg("thinkingText", thoughtSummaryText()), 1, 0) : this.body;
    if (view === "peek") child = new CodexThinkingPeekComponent(child, this.control, this.config.peekLines,
      text => this.theme.fg("dim", text), this.changed);
    if (view !== "collapsed" && this.config.rail) child = new CodexThinkingRailComponent(child, colorLevel());
    this.child = new CodexThinkingClickableComponent(child, this.control, view, () => { this.rebuild(); this.changed(); });
  }
  setExpanded(expanded: boolean) {
    this.control = createThinkingViewControl(); this.fallback = expanded ? "full" : "collapsed"; this.rebuild();
  }
  render(width: number) { return this.child.render(width); }
  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) { return this.child.handleMouse?.(event); }
  invalidate() { this.child.invalidate(); }
}

interface Entry { component: Component; bytes: number; tool?: ToolExecutionComponent; thought?: ThinkingBlock }

/** Owns this popup's components and manual choices; never feeds the parent transcript. */
export class ViewerContent {
  readonly entries: Entry[] = [];
  truncated = false;
  private readonly tools = new Map<string, Entry>();
  private readonly renderers;
  private toolsExpanded = false;
  private thinkingExpanded?: boolean;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly config: AppearanceConfig["thinking"];
  private readonly changed: () => void;
  constructor(theme: Theme, tui: TUI, config: AppearanceConfig["thinking"], changed: () => void) {
    this.theme = theme; this.tui = tui; this.config = config; this.changed = changed;
    const layout = { wrap: wrapTextWithAnsi, visibleWidth }, paint = (text: string, language: string) => highlightCode(text, language).join("\n");
    this.renderers = makeRenderers(text => new Text(text, 0, 0), () => keyHint("app.tools.expand", "to expand"), paint,
      input => createDiffComponent({ rows: input.rows, filePath: input.filePath, paint, colorLevel: colorLevel(),
        expanded: input.options.expanded === true, expandHint: input.expandHint ?? "" }, layout), createShellFactories(layout), undefined,
      { colorLevel: colorLevel(), writeChanges: new Map() }, layout);
  }
  private add(entry: Entry) { this.entries.push(entry); }
  private tool(id: string, name: string, args: Record<string, unknown>, cwd: string) {
    const renderer = name.startsWith("pi_") ? subagentToolRenderers(name)
      : this.renderers[(name === "exec_command" ? "bash" : name) as ToolName];
    const tool = new ToolExecutionComponent(name, `subagent-view:${id}:${this.entries.length}`,
      name === "exec_command" ? { ...args, command: args.cmd ?? args.command } : args, { showImages: false },
      renderer ? { ...renderer, renderShell: "self" } as ConstructorParameters<typeof ToolExecutionComponent>[4] : undefined, this.tui, cwd);
    tool.setArgsComplete(); tool.markExecutionStarted(); tool.setExpanded(this.toolsExpanded);
    const entry = { component: tool, tool, bytes: JSON.stringify(args).length };
    this.tools.set(id, entry); this.add(entry); return entry;
  }
  append(message: ViewerMessage, cwd: string) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "toolResult") {
      const entry = this.tools.get(message.toolCallId ?? "") ?? this.tool(message.toolCallId ?? "", message.toolName ?? "tool", {}, cwd);
      entry.tool!.updateResult({ content: blocks, isError: message.isError === true, details: message.details });
      entry.bytes += JSON.stringify(message).length;
    } else {
      for (const block of blocks) {
        if (block.type === "toolCall") this.tool(block.id ?? "", block.name ?? "tool", block.arguments ?? {}, cwd);
        else if (block.type === "thinking" && block.thinking) {
          const thought = new ThinkingBlock(block.thinking, this.theme, this.config, this.changed);
          if (this.thinkingExpanded !== undefined) thought.setExpanded(this.thinkingExpanded);
          this.add({ component: thought, thought, bytes: block.thinking.length });
        } else if (block.type === "text" && block.text) {
          const box = new Container();
          box.addChild(new Text(this.theme.fg(message.role === "user" ? "accent" : "muted", `${message.role}:`), 0, 0));
          box.addChild(new Markdown(cleanViewerText(block.text), 1, 0, getMarkdownTheme()));
          this.add({ component: box, bytes: block.text.length });
        }
      }
      if (message.errorMessage)
        this.add({
          component: new Text(this.theme.fg("error", cleanViewerText(message.errorMessage)), 1, 0),
          bytes: message.errorMessage.length,
        });
    }
    let bytes = this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.length > 256 || bytes > 524288) {
      const entry = this.entries.shift()!;
      bytes -= entry.bytes;
      for (const [id, item] of this.tools) if (item === entry) this.tools.delete(id);
      this.truncated = true;
    }
  }
  toggleTools() {
    this.toolsExpanded = !this.toolsExpanded;
    for (const entry of this.entries) entry.tool?.setExpanded(this.toolsExpanded);
  }
  toggleThinking() {
    this.thinkingExpanded = !(this.thinkingExpanded ?? this.config.completed === "full");
    for (const entry of this.entries) entry.thought?.setExpanded(this.thinkingExpanded);
  }
  dispose() {
    this.entries.length = 0;
    this.tools.clear();
    this.truncated = false;
  }
}
