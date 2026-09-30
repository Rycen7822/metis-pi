import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureToolResult } from "./batch-capture.ts";
import { archiveBatches } from "./spill.ts";
import type { ToolCallIndexer } from "./indexer.ts";

/** Native nested results are transient: archive them before the parent can be condensed. */
export function registerNestedCapture(pi: ExtensionAPI, indexer: ToolCallIndexer,
  protectedCall: (name: string, args: unknown) => boolean): void {
  const calls = new Map<string, { root: string; args: Record<string, unknown> }>();
  const roots = new Map<string, { protected: boolean; hasError: boolean; archiveFailed: boolean; pending: number; count: number; ended: boolean }>();
  const clear = () => { calls.clear(); roots.clear(); };
  pi.on("session_start", clear);
  pi.on("session_tree", clear);
  pi.on("session_shutdown", clear);
  const start = (id: string, parent: string, args: any) => {
    const root = calls.get(parent)?.root ?? parent;
    calls.set(id, { root, args: args as Record<string, unknown> });
    let state = roots.get(root);
    if (!state) roots.set(root, state = { protected: false, hasError: false, archiveFailed: false, pending: 0, count: 0, ended: false });
    state.pending++;
  };
  pi.on("tool_execution_start", event => {
    if (event.parentToolCallId) start(event.toolCallId, event.parentToolCallId, event.args);
  });
  pi.on("tool_call", event => {
    const call = calls.get(event.toolCallId);
    if (call) call.args = event.input;
  });
  const capture = async (id: string, name: string, result: any, isError: boolean, ctx: any) => {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    const state = roots.get(call.root);
    if (!state) return;
    state.protected ||= protectedCall(name, call.args);
    state.hasError ||= isError;
    state.count++;
    try {
      const timestamp = Date.now();
      const captured = captureToolResult(id, name, call.args,
        { ...result, content: result.structuredContent === undefined ? result.content
          : [...result.content, { type: "text", text: `\n[Structured content]\n${JSON.stringify(result.structuredContent)}` }],
          isError, timestamp });
      captured.parentToolCallId = call.root;
      await archiveBatches([{ turnIndex: -1, timestamp, assistantText: "", toolCalls: [captured] }], {
        indexer, sessionDir: ctx.sessionManager.getSessionDir(), sessionId: ctx.sessionManager.getSessionId(),
        appendEntry: (type, data) => pi.appendEntry(type, data), spillThreshold: 1, spillPreviewBytes: 2048,
      });
    } catch { state.archiveFailed = true; }
    finally {
      state.pending--;
      if (state.ended && !state.pending) roots.delete(call.root);
    }
  };
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.parentToolCallId) await capture(event.toolCallId, event.toolName, event.result, event.isError, ctx);
  });
  pi.on("tool_result", event => {
    const state = roots.get(event.toolCallId);
    if (!state) return;
    state.ended = true;
    if (!state.pending) roots.delete(event.toolCallId);
    const details = event.details && typeof event.details === "object" ? event.details : {};
    return { details: { ...details, metisNested: {
      protected: state.protected, hasError: state.hasError, archiveFailed: state.archiveFailed,
      unfinished: state.pending > 0, count: state.count,
    } } };
  });
}
