import * as Core from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TOOL_NAMES } from "../presentation/tool-names.ts";
import { bindAssistantTranscriptScope } from "../appearance/transcript/adapter.ts";
import { userTimestampComponent } from "../appearance/transcript/message-timestamp.ts";
import type { EmbeddedTranscript } from "../appearance/transcript/embedded.ts";
import type { TranscriptSurface } from "../appearance/transcript/surface.ts";
import { embeddedHost } from "./host.ts";

/** Native rows and Metis renderers; only the side session's component lifecycle lives here. */
export class BtwTranscript {
  private readonly tools = new Map<string, Core.ToolExecutionComponent>();
  private readonly unbind: Array<() => void> = [];
  private streaming?: Core.AssistantMessageComponent;
  private expanded = false;
  private hideThinking: boolean;
  private readonly host = embeddedHost();

  constructor(
    readonly document: Container,
    private readonly session: Core.AgentSession,
    private readonly surface: TranscriptSurface,
    private readonly presentation: EmbeddedTranscript | undefined,
    private readonly ui: TUI,
    messages: readonly AgentMessage[],
    partial?: AssistantMessage,
  ) {
    this.hideThinking = session.settingsManager.getHideThinkingBlock();
    for (const message of messages) this.append(message);
    if (partial) this.streaming = this.addAssistant(partial, true);
  }

  private get markdownTheme() {
    return { ...Core.getMarkdownTheme(), codeBlockIndent: this.session.settingsManager.getCodeBlockIndent() };
  }

  private append(message: AgentMessage): void {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content
        : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (!text) return;
      if (this.document.children.length) this.document.addChild(new Spacer(1));
      const skill = Core.parseSkillBlock(text);
      const pad = this.session.settingsManager.getOutputPad();
      if (skill) {
        const row = new Core.SkillInvocationMessageComponent(skill, this.markdownTheme, pad);
        row.setExpanded(this.expanded);
        this.document.addChild(row);
        if (skill.userMessage) {
          this.document.addChild(new Spacer(1));
          this.document.addChild(new Core.UserMessageComponent(skill.userMessage, this.markdownTheme, pad));
        }
      } else this.document.addChild(new Core.UserMessageComponent(text, this.markdownTheme, pad));
      const timestamp = this.presentation && userTimestampComponent(message.timestamp, () => pad);
      if (timestamp) this.document.addChild(timestamp);
    } else if (message.role === "assistant") {
      this.addAssistant(message, false);
    } else if (message.role === "toolResult") {
      this.tools.get(message.toolCallId)?.updateResult({ ...message, isError: message.isError === true });
      this.tools.delete(message.toolCallId);
    }
  }

  private addAssistant(message: AssistantMessage, streaming: boolean): Core.AssistantMessageComponent {
    const row = new Core.AssistantMessageComponent(
      undefined, this.hideThinking, this.markdownTheme, "Thinking...", this.session.settingsManager.getOutputPad(),
    );
    this.unbind.push(bindAssistantTranscriptScope(row, {
      state: this.surface.transcript, requestRender: () => this.ui.requestRender(),
    }));
    this.document.addChild(row);
    row.updateContent(message, streaming);
    this.updateToolCalls(message, !streaming);
    if (!streaming) this.finishAssistant(message);
    return row;
  }

  private tool(name: string, id: string, args: unknown): Core.ToolExecutionComponent {
    const existing = this.tools.get(id);
    if (existing) {
      existing.updateArgs(args);
      return existing;
    }
    const native = this.host.withBuiltInRenderers(name, this.session.getToolDefinition(name));
    const known = TOOL_NAMES.find(tool => tool === name);
    const renderer = known && this.presentation?.renderers[known];
    const definition: Core.ToolRenderers | undefined = renderer ? {
      ...native,
      renderCall: (value, theme, context) => renderer.renderCall(value, theme, context),
      renderResult: (value, options, theme, context) => renderer.renderResult(value, options, theme, context),
    } : native;
    const row = new Core.ToolExecutionComponent(name, id, args, {
      showImages: this.session.settingsManager.getShowImages(),
      imageWidthCells: this.session.settingsManager.getImageWidthCells(),
      outputPad: this.session.settingsManager.getOutputPad(),
    }, definition, this.ui, this.session.sessionManager.getCwd());
    row.setExpanded(this.expanded);
    this.tools.set(id, row);
    this.document.addChild(row);
    return row;
  }

  private updateToolCalls(message: AssistantMessage, complete: boolean): void {
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const row = this.tool(block.name, block.id, block.arguments);
      if (complete) row.setArgsComplete();
    }
  }

  private finishAssistant(message: AssistantMessage): void {
    if (message.stopReason !== "aborted" && message.stopReason !== "error") return;
    const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
    for (const row of this.tools.values()) row.updateResult({ content: [{ type: "text", text }], isError: true });
    this.tools.clear();
  }

  handleEvent(event: Core.AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.streaming = this.addAssistant(event.message, true);
        else if (event.message.role === "user") this.append(event.message);
        break;
      case "message_update":
      case "message_end":
        if (event.message.role !== "assistant") break;
        if (!this.streaming) this.streaming = this.addAssistant(event.message, event.type !== "message_end");
        else {
          this.streaming.updateContent(event.message, event.type !== "message_end");
          this.updateToolCalls(event.message, event.type === "message_end");
        }
        if (event.type === "message_end") {
          this.finishAssistant(event.message);
          this.streaming = undefined;
        }
        break;
      case "tool_execution_start":
        if (!event.parentToolCallId) this.tool(event.toolName, event.toolCallId, event.args).markExecutionStarted();
        break;
      case "tool_execution_update":
        this.tools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
        break;
      case "tool_execution_end":
        this.tools.get(event.toolCallId)?.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
        this.tools.delete(event.toolCallId);
        break;
    }
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const row of this.document.children) {
      if (row instanceof Core.ToolExecutionComponent || row instanceof Core.SkillInvocationMessageComponent) row.setExpanded(this.expanded);
    }
  }

  toggleThinking(): void {
    this.hideThinking = !this.hideThinking;
    for (const row of this.document.children) {
      if (row instanceof Core.AssistantMessageComponent) row.setHideThinkingBlock(this.hideThinking);
    }
  }

  dispose(): void {
    for (const unbind of this.unbind) unbind();
    this.tools.clear();
    this.unbind.length = 0;
  }
}
