import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ToolCallIndexer } from "../../src/condense/indexer.ts";
import { registerQueryTool } from "../../src/condense/query-tool.ts";

export const record = (id, text, timestamp = 3, extra = {}) => ({
  toolCallId: id,
  toolName: "read",
  args: { path: "old.txt" },
  resultText: text,
  isError: false,
  turnIndex: 1,
  timestamp: 4,
  resultTimestamp: timestamp,
  ...extra,
});
export function queryFixture(records, sessionManager = SessionManager.inMemory("/tmp/condense-query")) {
  const origin = sessionManager.appendMessage({ role: "user", content: "before archive", timestamp: 0 });
  sessionManager.appendCustomEntry("context-prune-index", { toolCalls: records });
  const ctx = { sessionManager };
  const indexer = new ToolCallIndexer();
  indexer.reconstructFromSession(ctx);
  let tool;
  registerQueryTool({ registerTool: (value) => { tool = value; } }, indexer);
  const run = (params, signal) => tool.execute("query", params, signal, undefined, ctx);
  return { run, indexer, ctx, tool, origin };
}
