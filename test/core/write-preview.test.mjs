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

test("an elision modifies body copy rows without consuming the caller's header/stage rows", () => {
  const view = component(Array.from({ length: 30 }, (_, i) => `ROW-${i + 1}`).join("\n"), 2);
  const frame = copyFrame(view, 60);
  assert.match(frame.root.lines[1], /Receiving content/);
  assert.doesNotMatch(frame.root.lines.join("\n"), /ROW-30/);
  assert.equal(select(frame, 0, 1).text, "", "header and stage cannot copy a hidden body row");
});
