import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { installAdapter } from "../../src/adapter.ts";
import { installTranscriptDecorations } from "../../src/transcript-adapter.ts";
import { TranscriptState } from "../../src/transcript-state.ts";
import { makeRenderers } from "../../src/renderers.ts";

Core.initTheme("dark", false);

test("real grouped self-shell rows need no stock-tree spacing patch, including native fallback and foreign owners", (t) => {
  const prototype = Core.ToolExecutionComponent.prototype;
  const nativeUpdate = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
  const transcript = new TranscriptState();
  for (const toolCallId of ["first", "second"]) {
    transcript.apply({ type: "tool_execution_start", toolCallId, toolName: "read" });
    transcript.apply({ type: "tool_execution_end", toolCallId, toolName: "read", imageCount: 0 });
  }
  let enabled = true;
  let foreign = false;
  const makeText = (text) => new Tui.Text(text, 0, 0);
  const adapter = installAdapter(prototype, {
    enabled: () => enabled,
    getTools: () => [{ name: "read", sourceInfo: foreign
      ? { source: "extension", path: "/foreign/index.ts" } : { source: "builtin", path: "<builtin:read>" } }],
    renderers: makeRenderers(makeText, () => "expand", undefined, undefined, undefined, undefined,
      { transcript, colorLevel: { kind: "ansi16" }, writeChanges: new Map() }),
  });
  assert.equal(adapter.installed, true);
  t.after(() => adapter.dispose());
  const rowFor = (id, definition = Core.createReadToolDefinition(process.cwd())) => {
    const row = new Core.ToolExecutionComponent("read", id, { path: `${id}.txt` },
      { showImages: false }, definition, { requestRender() {} }, process.cwd());
    row.updateResult({ content: [{ type: "text", text: `FULL ${id} CONTENT` }], isError: false });
    return row;
  };
  const rows = [rowFor("first"), rowFor("second")];
  const children = rows.map((row) => [...row.children]);
  const plain = (row) => stripVTControlCharacters(row.render(50).join("\n"));
  const before = rows.map(plain);
  assert.equal(before.join("\n").match(/Explored/g)?.length, 1, "one header for the exploration group");
  const decorations = installTranscriptDecorations({
    state: transcript, assistantPrototype: undefined,
    makeSeparator: () => makeText("separator"), makeSpacer: () => new Tui.Spacer(1),
    makeRail: undefined, enabled: () => enabled,
  });
  t.after(() => decorations.dispose());
  rows.forEach((row) => row.updateDisplay());
  assert.deepEqual(rows.map(plain), before, "the stock-tree patch cannot change self-shell output");
  rows[1].setExpanded(true);
  rows[1].imageComponents = [makeText("NATIVE IMAGE ROW")];
  assert.match(plain(rows[1]), /FULL second CONTENT[\s\S]*NATIVE IMAGE ROW/);
  enabled = false;
  rows.forEach((row, index) => {
    plain(row);
    assert.equal(row.getRenderShell(), "default");
    assert.deepEqual(row.children, children[index], "native fallback keeps the stock child tree");
  });
  enabled = true;
  foreign = true;
  const definition = { ...Core.createReadToolDefinition(process.cwd()), renderShell: "self",
    renderCall: () => makeText("FOREIGN CALL"), renderResult: () => makeText("FOREIGN RESULT") };
  const external = rowFor("foreign", definition);
  assert.match(plain(external), /FOREIGN CALL[\s\S]*FOREIGN RESULT/);
  assert.equal(external.getCallRenderer(), definition.renderCall);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), nativeUpdate,
    "assistant decoration must not install a bypassed tool-tree mutation hook");
});
