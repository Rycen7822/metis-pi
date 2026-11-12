import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { TranscriptState, semanticRuns } from "../../appearance/transcript/state.ts";
import { ConversationDocument, type TranscriptMessage } from "../../appearance/transcript/document.ts";
import { isExplorationTool } from "../../presentation/tool-names.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import { resolveColorContext } from "../../presentation/palette.ts";
import type { AppearanceConfig } from "../../appearance/config.ts";
import { makeViewerRenderers } from "./viewer-renderers.ts";

export const cleanViewerText = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
export interface ViewerMessage extends TranscriptMessage { nestedCalls?: unknown }

/** Read-only archive adapter: registration facts and paging stay outside the shared native document. */
export class ViewerContent {
  readonly document = new Container();
  private readonly transcript = new TranscriptState();
  private readonly conversation: ConversationDocument;
  private readonly rendering;
  private sources: Readonly<Record<string, ToolPresentation>> = {};

  private readonly config: AppearanceConfig;

  constructor(tui: TUI, config: AppearanceConfig, settings: SettingsManager) {
    this.config = config;
    this.rendering = makeViewerRenderers(config, this.transcript,
      resolveColorContext({ terminalTrueColor: getCapabilities().trueColor === true }), () => this.sources);
    this.conversation = new ConversationDocument(this.document, {
      ui: tui, settings, state: this.transcript, cwd: "", showImages: false,
      assistant: { enabled: () => config.enabled, thinkingPolicy: () => ({
        streaming: config.thinking.streaming, completed: config.thinking.completed, peekLines: config.thinking.peekLines,
      }) },
      limits: { entries: 256, bytes: 524288 },
      resolveTool: (name, result) => {
        const renderer = this.rendering.resolve(name, result);
        return renderer ? {
          ...(config.enabled ? { renderShell: "self" as const } : {}), ...renderer,
        } : {};
      },
    });
  }

  get truncated() { return this.conversation.truncated; }
  setToolRenderers(sources: Readonly<Record<string, ToolPresentation>>) { this.sources = sources; }

  append(message: ViewerMessage, cwd: string): void {
    if (message.role === "custom" && message.display === false) return;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "toolResult") {
      this.conversation.append(message, cwd);
      this.transcript.apply({ type: "tool_execution_end", toolCallId: message.toolCallId ?? "", toolName: message.toolName,
        isError: message.isError, imageCount: blocks.filter(block => block.type === "image").length });
      return;
    }
    if (message.role === "user" || semanticRuns(blocks).some(run => run.nonEmpty))
      this.transcript.apply({ type: "message_start", message: { role: "user", content: [] } });
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      const kind = this.sources[block.name ?? ""];
      this.transcript.apply({ type: "tool_execution_start", toolCallId: block.id ?? "", toolName: block.name,
        exploration: this.config.enabled && isExplorationTool(block.name ?? "", block.arguments)
          && (kind === "builtin" || kind === "fff" || kind === "neural") });
    }
    const display = { ...message, content: blocks.map(block => {
      if (block.type === "text") return { ...block, text: cleanViewerText(block.text ?? "") };
      if (block.type === "thinking") return { ...block, thinking: cleanViewerText(block.thinking ?? "") };
      return block;
    }), errorMessage: message.errorMessage ? cleanViewerText(message.errorMessage) : undefined,
      stopReason: message.stopReason ?? (message.errorMessage ? "error" : undefined) };
    if (message.role === "assistant") this.transcript.registerFinalizedMessage(display, false);
    this.conversation.append(message.role === "user" || message.role === "assistant" ? display
      : { ...display, role: "custom", customType: message.customType ?? message.role, display: message.display !== false }, cwd);
  }

  refresh(): void { this.conversation.refreshTools(); }
  toggleTools(): void { this.conversation.toggleExpanded(); }
  toggleThinking(): void { this.conversation.toggleThinking(); }
  dispose(): void { this.conversation.dispose(); this.transcript.resetSession(); this.rendering.clear(); }
}
