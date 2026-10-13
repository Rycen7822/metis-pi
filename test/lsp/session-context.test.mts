// Derived from pi-lsp 0.49.9 (55d7847); MIT copyright 2026 narumiruna.
import assert from "node:assert/strict";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { test, mock } from "node:test";
import { createMockContext } from "./host.ts";
import { LspSessionScope } from "../../src/pi-lsp/session-lifecycle.ts";

test("session context preserves lazy tool capabilities and guards UI after closure", async () => {
  const scope = new LspSessionScope();
  const baseContext: ExtensionContext = createMockContext().ctx;
  const tools: ExtensionToolContext["tools"] = [];
  const executeTool = mock.fn<ExtensionToolContext["executeTool"]>(async () => ({
    toolCall: { type: "toolCall", id: "parent/1", name: "read", arguments: { path: "main.go" } },
    result: { content: [], details: undefined },
    isError: false,
  }));
  let toolReads = 0;
  let uiReads = 0;
  const ctx: ExtensionToolContext = Object.create(baseContext, {
    tools: {
      get() {
        toolReads++;
        return tools;
      },
    },
    executeTool: { value: executeTool },
    ui: {
      get() {
        uiReads++;
        return baseContext.ui;
      },
    },
  });

  const guarded = scope.context(ctx);
  assert.notEqual(guarded, ctx);
  assert.equal(guarded.sessionManager, ctx.sessionManager);
  assert.equal(toolReads, 0);
  assert.equal(uiReads, 0);
  assert.equal(guarded.tools, tools);
  assert.equal(toolReads, 1);
  assert.equal(guarded.executeTool, executeTool);
  const signal = new AbortController().signal;
  await guarded.executeTool("read", { path: "main.go" }, { signal });
  assert.deepEqual(executeTool.mock.calls.map(call => call.arguments), [["read", { path: "main.go" }, { signal }]]);
  assert.equal(guarded.ui, baseContext.ui);
  assert.equal(uiReads, 1);

  await scope.close();
  assert.throws(() => guarded.ui, /session is closing/u);
  assert.equal(uiReads, 1, "closing must reject before reaching the original UI getter");
});
