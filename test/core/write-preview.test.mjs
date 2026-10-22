import test from "node:test";
import assert from "node:assert/strict";
import { CodexWriteCallComponent } from "../../src/presentation/components/transcript-components.ts";
import { layout } from "../helpers/layout.mjs";
import { copyFrame, select } from "../helpers/ui-fixtures.mjs";

const component = (contentPrefix, maxRows) => new CodexWriteCallComponent({
  contentPrefix, maxRows, headerText: "WRITE file.txt", stage: "receiving-arguments", expanded: false,
  theme: { fg: (_role, value) => value, bold: value => value }, colorLevel: { kind: "none" }, layout,
});

test("disabled preview preserves only header/stage and makes their decorations uncopyable", () => {
  const view = component("DISABLED_PREVIEW_CONTENT", 0);
  const frame = copyFrame(view, 60);
  assert.equal(frame.root.lines.length, 2);
  assert.match(frame.root.lines[0], /WRITE file\.txt/);
  assert.match(frame.root.lines[1], /Receiving content/);
  assert.doesNotMatch(frame.root.lines.join("\n"), /DISABLED_PREVIEW_CONTENT/);
  assert.equal(select(frame).text, "");
});

test("a truncated preview counts its own header inside writePreview.rows", () => {
  const text = Array.from({ length: 400 }, (_, i) => `ROW-${i + 1}`).join("\n");
  for (const maxRows of [0, 1, 2, 3, 8, 12, 64]) {
    const lines = component(text, maxRows).render(60);
    // Header + stage line are the smallest complete preview, which is also what
    // rows = 0 documents; larger budgets bound the whole block.
    assert.ok(lines.length <= Math.max(2, maxRows), `${lines.length} rows exceed the ${maxRows}-row block budget`);
    assert.match(lines[0], /WRITE file\.txt/, "the call header stays visible");
    assert.match(lines[1], /Receiving content/, "the stage line stays visible");
    if (maxRows >= 3) assert.match(lines.at(-1), /earlier output/, "the elision hint is disclosed");
  }
});

test("an elision modifies body copy rows without consuming the caller's header/stage rows", () => {
  const view = component(Array.from({ length: 30 }, (_, i) => `ROW-${i + 1}`).join("\n"), 2);
  const frame = copyFrame(view, 60);
  assert.match(frame.root.lines[1], /Receiving content/);
  assert.doesNotMatch(frame.root.lines.join("\n"), /ROW-30/);
  assert.equal(select(frame, 0, 1).text, "", "header and stage cannot copy a hidden body row");
});
