import * as Core from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { bindAssistantTranscriptScope, type AssistantTranscriptScope } from "./adapter.ts";
import type { TranscriptState } from "./state.ts";
import { userTimestampComponent } from "./message-timestamp.ts";

/** Display projection, not a provider request or an invented AgentSession. Archives may omit transport metadata. */
export interface TranscriptMessage {
  role: string;
  content: string | Array<{
    type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown>;
  }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  durationMs?: number;
  errorMessage?: string;
  customType?: string;
  display?: boolean;
  timestamp?: number;
  stopReason?: AssistantMessage["stopReason"];
}

function messageText(message: Pick<TranscriptMessage, "content">): string {
  return typeof message.content === "string" ? message.content
    : message.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

interface Entry {
  component: Component;
  bytes: number;
  release?: () => void;
  id?: string;
  result?: TranscriptMessage;
}
interface ToolEntry extends Entry {
  component: Core.ToolExecutionComponent;
  id: string;
  args: unknown;
  pending: boolean;
}

interface DocumentOptions {
  ui: TUI;
  settings: Core.SettingsManager;
  state: TranscriptState;
  cwd: string;
  resolveTool(name: string, result: () => TranscriptMessage | undefined): Core.ToolRenderers | undefined;
  timestamps?: boolean;
  showImages?: boolean;
  assistant?: Pick<AssistantTranscriptScope, "enabled" | "thinkingPolicy">;
  limits?: { entries: number; bytes: number };
}

/** Native rows and one component lifecycle, shared by live side sessions and bounded archive viewers. */
export class ConversationDocument {
  private readonly entries: Entry[] = [];
  private readonly tools = new Map<string, ToolEntry>();
  private streaming?: Core.AssistantMessageComponent;
  private expanded = false;
  private hideThinking: boolean;
  private bytes = 0;
  truncated = false;

  readonly document: Container;
  private readonly options: DocumentOptions;

  constructor(document: Container, options: DocumentOptions) {
    this.document = document;
    this.options = options;
    this.hideThinking = options.assistant?.enabled?.()
      ? options.assistant.thinkingPolicy?.().completed === "collapsed" : options.settings.getHideThinkingBlock();
  }

  private get markdownTheme() {
    return { ...Core.getMarkdownTheme(), codeBlockIndent: this.options.settings.getCodeBlockIndent() };
  }

  private size(message: unknown): number {
    return this.options.limits ? Buffer.byteLength(JSON.stringify(message), "utf8") : 0;
  }

  private add(entry: Entry): void {
    this.entries.push(entry);
    this.bytes += entry.bytes;
    this.document.addChild(entry.component);
  }

  private trim(): void {
    const limits = this.options.limits;
    if (!limits) return;
    while (this.entries.length > limits.entries || this.bytes > limits.bytes) {
      const entry = this.entries.shift();
      if (!entry) break;
      this.bytes -= entry.bytes;
      this.document.removeChild(entry.component);
      entry.release?.();
      if (entry.id !== undefined && this.tools.get(entry.id) === entry) {
        this.tools.delete(entry.id);
      }
      this.truncated = true;
    }
    if (this.truncated) this.options.state.retainTools(new Set(this.tools.keys()));
  }

  append(message: TranscriptMessage | AgentMessage, cwd = this.options.cwd): void {
    if (!("content" in message)) return;
    if (message.role === "user") {
      const text = messageText(message);
      if (!text) return;
      const box = new Container(), pad = this.options.settings.getOutputPad();
      if (this.entries.length) box.addChild(new Spacer(1));
      const skill = Core.parseSkillBlock(text);
      if (skill) {
        const row = new Core.SkillInvocationMessageComponent(skill, this.markdownTheme, pad);
        row.setExpanded(this.expanded);
        box.addChild(row);
        if (skill.userMessage) {
          box.addChild(new Spacer(1));
          box.addChild(new Core.UserMessageComponent(skill.userMessage, this.markdownTheme, pad));
        }
      } else box.addChild(new Core.UserMessageComponent(text, this.markdownTheme, pad));
      const timestamp = this.options.timestamps && message.timestamp !== undefined
        ? userTimestampComponent(message.timestamp, () => pad) : undefined;
      if (timestamp) box.addChild(timestamp);
      this.add({ component: box, bytes: this.size(message) });
    } else if (message.role === "assistant") {
      this.addAssistant(message, false, cwd);
    } else if (message.role === "toolResult") {
      const entry = this.tools.get(message.toolCallId ?? "") ?? this.tool(message.toolName ?? "tool", message.toolCallId ?? "", {}, cwd);
      this.updateResult(entry, message);
    } else if (message.role === "custom" && message.display !== false) {
      const content = messageText(message);
      const row = new Core.CustomMessageComponent({ role: "custom", customType: message.customType ?? "message",
        content, display: true, timestamp: message.timestamp ?? 0, details: message.details,
      }, undefined, this.markdownTheme, this.options.settings.getOutputPad());
      row.setExpanded(this.expanded);
      this.add({ component: row, bytes: this.size(message) });
    }
    this.trim();
  }

  private updateAssistant(row: Core.AssistantMessageComponent, message: TranscriptMessage, streaming: boolean,
    cwd = this.options.cwd): void {
    // Pi1.5.2's row consumes content/error state, not api/model/usage. Keep the archive projection at this UI boundary;
    // do not manufacture transport facts just to satisfy the SDK's broader AssistantMessage annotation.
    const native = typeof message.content === "string"
      ? { ...message, content: [{ type: "text", text: message.content }] } : message;
    row.updateContent(native as AssistantMessage, streaming);
    this.updateToolCalls(message, !streaming, cwd);
    if (!streaming) this.finishAssistant(message);
  }

  private addAssistant(message: TranscriptMessage, streaming: boolean, cwd: string): Core.AssistantMessageComponent {
    const row = new Core.AssistantMessageComponent(
      undefined, this.hideThinking, this.markdownTheme, "Thinking...", this.options.settings.getOutputPad(),
    );
    const unbind = bindAssistantTranscriptScope(row, {
      ...this.options.assistant, state: this.options.state, requestRender: () => this.options.ui.requestRender(),
    });
    const release = () => {
      unbind();
      if (this.options.limits) { this.options.state.forgetMessage(message); this.options.state.forgetMessage(row); }
    };
    this.add({ component: row, release, bytes: this.size(message) });
    this.updateAssistant(row, message, streaming, cwd);
    return row;
  }

  private tool(name: string, id: string, args: unknown, cwd = this.options.cwd): ToolEntry {
    const existing = this.tools.get(id);
    if (existing?.pending) { existing.args = args; existing.component.updateArgs(args); return existing; }
    let entry: ToolEntry;
    const definition = this.options.resolveTool(name, () => entry?.result);
    const row = new Core.ToolExecutionComponent(name, id, args, {
      showImages: this.options.showImages ?? this.options.settings.getShowImages(),
      imageWidthCells: this.options.settings.getImageWidthCells(),
      outputPad: this.options.settings.getOutputPad(),
    }, definition, this.options.ui, cwd);
    row.setExpanded(this.expanded);
    entry = { component: row, id, args, pending: true, bytes: this.size(args) };
    this.tools.set(id, entry);
    this.add(entry);
    return entry;
  }

  private updateToolCalls(message: TranscriptMessage, complete: boolean, cwd = this.options.cwd): void {
    if (typeof message.content === "string") return;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const entry = this.tool(block.name ?? "tool", block.id ?? "", block.arguments ?? {}, cwd);
      if (complete) entry.component.setArgsComplete();
    }
  }

  private updateResult(entry: ToolEntry, message: TranscriptMessage, partial = false): void {
    const previous = entry.result;
    entry.result = message;
    if (!partial) entry.component.setArgsComplete();
    entry.component.updateResult({ ...message, content: typeof message.content === "string"
      ? [{ type: "text", text: message.content }] : message.content, isError: message.isError === true }, partial);
    const growth = this.size(message) - (previous ? this.size(previous) : 0);
    entry.bytes += growth; this.bytes += growth;
    if (!partial) entry.pending = false;
  }

  private finishAssistant(message: TranscriptMessage): void {
    if (message.stopReason !== "aborted" && message.stopReason !== "error") return;
    const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
    for (const entry of this.tools.values()) if (entry.pending) this.updateResult(entry, {
      role: "toolResult", content: [{ type: "text", text }], isError: true,
    });
  }

  handleEvent(event: Core.AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.streaming = this.addAssistant(event.message, true, this.options.cwd);
        else if (event.message.role === "user") this.append(event.message);
        break;
      case "message_update":
      case "message_end":
        if (event.message.role !== "assistant") break;
        if (!this.streaming) this.streaming = this.addAssistant(event.message, event.type !== "message_end", this.options.cwd);
        else this.updateAssistant(this.streaming, event.message, event.type !== "message_end");
        if (event.type === "message_end") this.streaming = undefined;
        break;
      case "tool_execution_start":
        if (!event.parentToolCallId) this.tool(event.toolName, event.toolCallId, event.args).component.markExecutionStarted();
        break;
      case "tool_execution_update": {
        const entry = this.tools.get(event.toolCallId);
        if (entry) this.updateResult(entry, { ...event.partialResult, role: "toolResult", isError: false }, true);
        break;
      }
      case "tool_execution_end": {
        const entry = this.tools.get(event.toolCallId);
        if (entry) this.updateResult(entry, { ...event.result, role: "toolResult", isError: event.isError, durationMs: event.durationMs });
        break;
      }
    }
  }

  refreshTools(): void {
    for (const entry of this.tools.values()) entry.component.updateArgs(entry.args);
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const { component } of this.entries) {
      if (component instanceof Core.ToolExecutionComponent || component instanceof Core.CustomMessageComponent)
        component.setExpanded(this.expanded);
      if (component instanceof Container)
        for (const child of component.children)
          if (child instanceof Core.SkillInvocationMessageComponent) child.setExpanded(this.expanded);
    }
  }

  toggleThinking(): void {
    this.hideThinking = !this.hideThinking;
    for (const { component } of this.entries)
      if (component instanceof Core.AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
  }

  dispose(): void {
    for (const entry of this.entries) entry.release?.();
    this.entries.length = 0; this.tools.clear();
    this.streaming = undefined; this.bytes = 0; this.truncated = false;
    this.document.clear();
  }
}
