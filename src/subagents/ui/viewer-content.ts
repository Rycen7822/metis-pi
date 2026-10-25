import { ToolExecutionComponent, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Text, getCapabilities, type Component, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { TranscriptState, semanticRuns } from "../../appearance/transcript/state.ts";
import type { ExplorationPlan } from "../../presentation/contracts.ts";
import { isExplorationTool } from "../../presentation/tool-names.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import { ThinkingClickableComponent, ThinkingPeekComponent, ThinkingRailComponent } from "../../presentation/components/transcript-components.ts";
import { createThinkingViewControl, type ThinkingView } from "../../presentation/thinking-view.ts";
import { thoughtSummaryText } from "../../presentation/thinking-summary.ts";
import { resolveColorContext } from "../../presentation/palette.ts";
import type { AppearanceConfig } from "../../appearance/config.ts";
import { makeViewerRenderers } from "./viewer-renderers.ts";

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
  nestedCalls?: unknown;
  durationMs?: number;
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
  private readonly nativeStyle: boolean;
  constructor(text: string, theme: Theme, config: AppearanceConfig["thinking"], changed: () => void, nativeStyle = false) {
    this.theme = theme; this.config = config; this.changed = changed; this.nativeStyle = nativeStyle;
    this.body = new Markdown(cleanViewerText(text), 1, 0, getMarkdownTheme(), { color: value => theme.fg("thinkingText", value), italic: true });
    this.fallback = nativeStyle ? "full" : config.completed; this.rebuild();
  }
  private rebuild() {
    const view = this.control.userView() ?? this.fallback;
    if (this.nativeStyle) {
      // Stay local: a native AssistantMessageComponent can inherit the parent's transcript lease.
      this.child = new MouseRegion(view === "collapsed" ? new Text(this.theme.fg("muted", "Thinking..."), 1, 0) : this.body, event => {
        if (event.type !== "click" || event.button !== "left" || event.shift || event.ctrl || event.alt) return;
        this.setExpanded(view === "collapsed"); this.changed(); return { handled: true };
      });
      return;
    }
    let child: Component = view === "collapsed" ? new Text(this.theme.fg("thinkingText", thoughtSummaryText()), 1, 0) : this.body;
    if (view === "peek") child = new ThinkingPeekComponent(child, this.control, this.config.peekLines,
      text => this.theme.fg("dim", text), this.changed);
    if (view !== "collapsed" && this.config.rail) child = new ThinkingRailComponent(child, colorLevel());
    this.child = new ThinkingClickableComponent(child, this.control, view, () => { this.rebuild(); this.changed(); });
  }
  setExpanded(expanded: boolean) {
    this.control = createThinkingViewControl(); this.fallback = expanded ? "full" : "collapsed"; this.rebuild();
  }
  render(width: number) { return this.child.render(width); }
  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) { return this.child.handleMouse?.(event); }
  invalidate() { this.child.invalidate(); }
}

interface Entry { component: Component; bytes: number; id?: string; tool?: ToolExecutionComponent; thought?: ThinkingBlock }
interface ToolEntry extends Entry {
  tool: ToolExecutionComponent;
  id: string;
  args: Record<string, unknown>;
  result?: ViewerMessage;
  exploration: boolean;
  plan?: ExplorationPlan;
}

/** Owns this popup's components and manual choices; never feeds the parent transcript. */
export class ViewerContent {
  readonly entries: Entry[] = [];
  truncated = false;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly transcript = new TranscriptState();
  private readonly rendering;
  private sources: Readonly<Record<string, ToolPresentation>> = {};
  private toolsExpanded = false;
  private thinkingExpanded?: boolean;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly config: AppearanceConfig;
  private readonly changed: () => void;
  constructor(theme: Theme, tui: TUI, config: AppearanceConfig, changed: () => void) {
    this.theme = theme; this.tui = tui; this.config = config; this.changed = changed;
    this.rendering = makeViewerRenderers(config, this.transcript, colorLevel(), () => this.sources);
  }
  setToolRenderers(sources: Readonly<Record<string, ToolPresentation>>) { this.sources = sources; }
  private add(entry: Entry) { this.entries.push(entry); }
  private tool(id: string, name: string, args: Record<string, unknown>, cwd: string) {
    const kind = this.sources[name];
    const exploration = this.config.enabled && isExplorationTool(name, args)
      && (kind === "builtin" || kind === "fff" || kind === "neural");
    this.transcript.apply({ type: "tool_execution_start", toolCallId: id, toolName: name, exploration });
    let entry: ToolEntry | undefined;
    const renderer = this.rendering.resolve(name, () => entry?.result);
    // The rendering factory owns its callbacks. An empty definition earns the SDK's bounded fallback.
    const definition = renderer ? { ...renderer, ...(this.config.enabled ? { renderShell: "self" } : {}) } : {};
    const tool = new ToolExecutionComponent(name, id, args, { showImages: false },
      definition as ConstructorParameters<typeof ToolExecutionComponent>[4], this.tui, cwd);
    tool.setArgsComplete(); tool.setExpanded(this.toolsExpanded);
    entry = { component: tool, tool, id, args, exploration, bytes: JSON.stringify(args).length };
    this.tools.set(id, entry); this.add(entry); return entry;
  }
  private refreshExploration() {
    for (const entry of this.tools.values()) {
      if (!entry.exploration) continue;
      const next = this.transcript.explorationPlan(entry.id), before = entry.plan;
      if (!before || !next || before.isHeaderOwner !== next.isHeaderOwner || before.isLastMember !== next.isLastMember
        || before.running !== next.running || before.groupImages !== next.groupImages) {
        entry.plan = next;
        entry.tool.updateArgs(entry.args);
      }
    }
  }
  append(message: ViewerMessage, cwd: string) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "toolResult") {
      const entry = this.tools.get(message.toolCallId ?? "") ?? this.tool(message.toolCallId ?? "", message.toolName ?? "tool", {}, cwd);
      entry.result = message;
      entry.tool.updateResult({ content: blocks, isError: message.isError === true, details: message.details, durationMs: message.durationMs });
      entry.bytes += JSON.stringify(message).length;
      this.transcript.apply({ type: "tool_execution_end", toolCallId: entry.id, toolName: message.toolName,
        isError: message.isError, imageCount: blocks.filter(block => block.type === "image").length });
    } else {
      const runs = semanticRuns(blocks);
      if (message.role === "user" || runs.some(run => run.nonEmpty))
        this.transcript.apply({ type: "message_start", message: { role: "user", content: [] } });
      for (const [index, run] of runs.entries()) {
        const parts = blocks.slice(run.firstContentIndex, runs[index + 1]?.firstContentIndex ?? blocks.length);
        const block = parts[0]!;
        if (run.kind === "thinking") {
          const text = parts.map(part => part.thinking?.trim()).filter(Boolean).join("\n\n");
          if (!text) continue;
          const thought = new ThinkingBlock(text, this.theme, this.config.thinking, this.changed, !this.config.enabled);
          if (this.thinkingExpanded !== undefined) thought.setExpanded(this.thinkingExpanded);
          this.add({ component: thought, thought, bytes: text.length });
        } else if (block.type === "toolCall") this.tool(block.id ?? "", block.name ?? "tool", block.arguments ?? {}, cwd);
        else if (block.type === "text" && block.text) {
          const box = new Container();
          box.addChild(new Text(this.theme.fg(message.role === "user" ? "accent" : "muted", `${message.role}:`), 0, 0));
          box.addChild(new Markdown(cleanViewerText(block.text), 1, 0, getMarkdownTheme()));
          this.add({ component: box, bytes: block.text.length });
        }
      }
      if (message.errorMessage)
        this.add({ component: new Text(this.theme.fg("error", cleanViewerText(message.errorMessage)), 1, 0), bytes: message.errorMessage.length });
    }
    let bytes = this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.length > 256 || bytes > 524288) {
      const entry = this.entries.shift()!;
      bytes -= entry.bytes;
      if (entry.id !== undefined && this.tools.get(entry.id) === entry) this.tools.delete(entry.id);
      this.truncated = true;
    }
    if (this.truncated) this.transcript.retainTools(new Set(this.tools.keys()));
    this.refreshExploration();
  }
  toggleTools() {
    this.toolsExpanded = !this.toolsExpanded;
    for (const entry of this.entries) entry.tool?.setExpanded(this.toolsExpanded);
  }
  toggleThinking() {
    this.thinkingExpanded = !(this.thinkingExpanded ?? (!this.config.enabled || this.config.thinking.completed === "full"));
    for (const entry of this.entries) entry.thought?.setExpanded(this.thinkingExpanded);
  }
  dispose() {
    this.entries.length = 0;
    this.tools.clear();
    this.transcript.resetSession();
    this.rendering.clear();
    this.truncated = false;
  }
}
