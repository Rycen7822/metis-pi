import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedApplyPatchView } from "../../src/apply-patch-view.ts";
import { clearApplyPatchRenderState, getApplyPatchRenderSnapshot, markApplyPatchFailure, setApplyPatchRenderState } from "../../vendor/pi-codex-conversion/dist/tools/apply-patch/render-state.js";
import { bindings, theme } from "../helpers.mjs";
import { productFor } from "../../src/selection-copy/model.ts";

test("patch view reads the pre-execution snapshot and falls back on missing/failed state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "metis-patch-view-"));
  const patch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
  const args = { input: patch };
  const context = { toolCallId: "snapshot", cwd, expanded: true };
  const captured = [];
  const view = createOwnedApplyPatchView(bindings.makeText, (input) => {
    captured.push(input);
    return bindings.makeText(input.rows.map(row => row.content).join("\n"));
  }, bindings.expandHint);
  try {
    assert.equal(view.renderCall(args, theme, context), undefined);
    writeFileSync(join(cwd, "old.txt"), "original\n");
    setApplyPatchRenderState("snapshot", patch, cwd, "pending", undefined, true);
    const snapshot = getApplyPatchRenderSnapshot("snapshot");
    rmSync(join(cwd, "old.txt"));
    const output = view.renderCall(args, theme, context).render(80).join("\n");
    assert.match(output, /Deleted old.txt/);
    assert.match(output, /original/);
    assert.deepEqual(captured[0].rows, [{kind:"remove", lineNumber:1, content:"original"}]);
    assert.equal(getApplyPatchRenderSnapshot("snapshot"), snapshot, "display does not rewrite owned state");
    assert.match(view.renderCall(args, theme, {...context, expanded:false}).render(80).join("\n"), /original/, "folded preview shares the snapshot and painter");
    assert.equal(captured.at(-1).options.expanded, false);
    assert.equal(view.renderCall(args, theme, {...context, argsComplete:false}), undefined);
    assert.equal(view.renderCall(args, theme, {...context, isError:true}), undefined);
    for (const status of ["partial_failure", "failed"]) {
      markApplyPatchFailure("snapshot", status, ["old.txt"]);
      assert.equal(view.renderCall(args, theme, context), undefined);
    }
    clearApplyPatchRenderState();
    assert.equal(view.renderCall(args, theme, context), undefined);
  } finally {
    clearApplyPatchRenderState();
    rmSync(cwd, {recursive:true,force:true});
  }
});

test("summary-only preference stays native while expansion still uses Codex", () => {
  const patch = "*** Begin Patch\n*** Add File: summary.txt\n+hello\n*** End Patch";
  const view = createOwnedApplyPatchView(bindings.makeText, () => bindings.makeText("diff"), bindings.expandHint);
  try {
    setApplyPatchRenderState("summary", patch, process.cwd());
    assert.equal(view.renderCall({input:patch}, theme, {toolCallId:"summary", expanded:false}), undefined);
    assert.match(view.renderCall({input:patch}, theme, {toolCallId:"summary", expanded:true}).render(80).join("\n"), /diff/);
  } finally {
    clearApplyPatchRenderState();
  }
});

test("folded multi-file budget keeps copy rows aligned and expansion restores all rows", () => {
  const patch = "*** Begin Patch\n" + ["first.txt", "second.txt"].map(path =>
    `*** Add File: ${path}\n` + Array.from({length:20}, (_, i) => `+line ${i + 1}\n`).join("")
  ).join("") + "*** End Patch";
  const view = createOwnedApplyPatchView(bindings.makeText, input => bindings.makeText(input.rows.map(row => row.content).join("\n")), bindings.expandHint);
  try {
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
  } finally {
    clearApplyPatchRenderState();
  }
});
