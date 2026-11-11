import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ColorLevel } from "../../presentation/palette.ts";
import type { WriteDiff } from "../../file-changes/diff.ts";
import { resolveNativeMutationPath } from "../../file-changes/path.ts";
import { asRecord, isExplorationTool } from "../../presentation/tool-names.ts";
import { OWNED_NEURAL_SEARCH_ENTRY } from "../../extension-paths.ts";
import { CodemodeViewStore } from "./codemode-view.ts";
import { WriteDiffTracker } from "./write-tracker.ts";
import { TranscriptState, toTranscriptMessage, type TranscriptEvent } from "./state.ts";

/** Main and embedded transcripts share the event rules, never their state. */
export function createTranscriptSurface(colorLevel: ColorLevel, sourceInfoFor: (name: string) => unknown) {
  const transcript = new TranscriptState();
  const tracker = new WriteDiffTracker();
  const codemodeViews = new CodemodeViewStore();
  const session = { colorLevel, writeChanges: new Map<string, WriteDiff>(), transcript };

  function observe(event: AgentSessionEvent, cwd: string): TranscriptEvent["message"] {
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end": {
        if (event.type === "message_end") codemodeViews.recordMessage(event.message);
        const message = toTranscriptMessage(event.message);
        transcript.apply({ type: event.type, message }, event.message);
        return message;
      }
      case "tool_execution_start": {
        const info = sourceInfoFor(event.toolName);
        const source = asRecord(info);
        codemodeViews.start(event, event.toolName === "codemode" && source.source === "builtin" && source.path === "builtin:codemode");
        tracker.trackStart(event.toolCallId, event.toolName, event.args, info, path => resolveNativeMutationPath(cwd, path));
        if (!event.parentToolCallId) transcript.apply({
          type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
          exploration: event.toolName === "neural_search"
            ? typeof source.source === "string" && source.path === OWNED_NEURAL_SEARCH_ENTRY && isExplorationTool(event.toolName, event.args)
            : undefined,
        });
        break;
      }
      case "tool_execution_end": {
        codemodeViews.finish(event);
        const change = tracker.trackEnd(event.toolCallId, event.toolName, sourceInfoFor(event.toolName), event.isError);
        if (change) {
          session.writeChanges.set(event.toolCallId, change);
          if (session.writeChanges.size > 64) {
            const oldest = session.writeChanges.keys().next().value;
            if (oldest !== undefined) session.writeChanges.delete(oldest);
          }
        }
        if (!event.parentToolCallId) transcript.apply({
          type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
          isError: event.isError === true, imageCount: imageCount(event.result),
        });
        break;
      }
    }
  }

  function reset(): void {
    session.writeChanges.clear();
    codemodeViews.clear();
    transcript.resetSession();
  }

  return { transcript, codemodeViews, session, observe, reset };
}

export type TranscriptSurface = ReturnType<typeof createTranscriptSurface>;

function imageCount(result: unknown): number {
  try {
    const content = asRecord(result).content;
    return Array.isArray(content) ? content.filter(block => asRecord(block).type === "image").length : 0;
  } catch {
    return 0;
  }
}
