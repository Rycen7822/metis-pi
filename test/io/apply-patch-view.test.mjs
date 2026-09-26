import test from "node:test";
import assert from "node:assert/strict";
import { createOwnedApplyPatchView } from "../../src/apply-patch-view.ts";
import { clearApplyPatchRenderState, markApplyPatchFailure, setApplyPatchRenderState } from "../../vendor/pi-codex-conversion/dist/tools/apply-patch/render-state.js";
import { bindings, theme } from "../helpers.mjs";
import { productFor } from "../../src/selection-copy/model.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

test.afterEach(clearApplyPatchRenderState);

test("single-file view follows readiness, compact preference and failure state", (t) => {
  const cwd = temporaryDirectory(t, "metis-patch-view-");
  const patch = "*** Begin Patch\n*** Add File: summary.txt\n+hello\n*** End Patch";
  const args = { input: patch };
  const context = { toolCallId: "snapshot", cwd, expanded: true };
  const view = createOwnedApplyPatchView(bindings.makeText, () => bindings.makeText("diff"), bindings.expandHint);
  assert.equal(view.renderCall(args, theme, context), undefined);
  setApplyPatchRenderState("snapshot", patch, cwd);
  assert.match(view.renderCall(args, theme, context).render(80).join("\n"), /Added summary\.txt[\s\S]*diff/);
  assert.equal(view.renderCall(args, theme, { ...context, expanded: false }), undefined);
  setApplyPatchRenderState("snapshot", patch, cwd, "pending", undefined, true);
  assert.match(view.renderCall(args, theme, { ...context, expanded: false }).render(80).join("\n"), /diff/);
  for (const overrides of [{ argsComplete: false }, { isError: true }]) {
    assert.equal(view.renderCall(args, theme, { ...context, ...overrides }), undefined);
  }
  for (const status of ["partial_failure", "failed"]) {
    markApplyPatchFailure("snapshot", status);
    assert.equal(view.renderCall(args, theme, context), undefined);
  }
  clearApplyPatchRenderState();
  assert.equal(view.renderCall(args, theme, context), undefined);
});

test("folded multi-file budget keeps copy rows aligned and expansion restores all rows", () => {
  const patch = "*** Begin Patch\n" + ["first.txt", "second.txt"].map(path =>
    `*** Add File: ${path}\n` + Array.from({length:20}, (_, i) => `+line ${i + 1}\n`).join("")
  ).join("") + "*** End Patch";
  const view = createOwnedApplyPatchView(bindings.makeText, input => bindings.makeText(input.rows.map(row => row.content).join("\n")), bindings.expandHint);
  setApplyPatchRenderState("budget", patch, process.cwd(), "pending", undefined, true);
  for (const expanded of [false, true, false]) {
    const lines = view.renderCall({input:patch}, theme, {toolCallId:"budget", expanded}).render(80);
    const product = productFor(lines);
    assert.equal(product.rows.length, lines.length);
    if (expanded) {
      assert.equal(lines.length, 43);
      assert.match(lines.join("\n"), /second.txt/);
    } else {
      assert.equal(lines.length, 12);
      assert.match(lines.at(-1), /32 more rows/);
      assert.equal(product.rows.at(-1).breakBefore, "gap");
      assert.doesNotMatch(lines.join("\n"), /second.txt/);
    }
  }
});
