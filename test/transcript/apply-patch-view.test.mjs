import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedApplyPatchView } from "../../src/apply-patch-view.ts";
import { clearApplyPatchRenderState, getApplyPatchRenderSnapshot, markApplyPatchFailure, setApplyPatchRenderState } from "../../vendor/pi-codex-conversion/dist/tools/apply-patch/render-state.js";
import { bindings, theme } from "../helpers.mjs";

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
    setApplyPatchRenderState("snapshot", patch, cwd);
    const snapshot = getApplyPatchRenderSnapshot("snapshot");
    rmSync(join(cwd, "old.txt"));
    const output = view.renderCall(args, theme, context).render(80).join("\n");
    assert.match(output, /Deleted old.txt/);
    assert.match(output, /original/);
    assert.deepEqual(captured[0].rows, [{kind:"remove", lineNumber:1, content:"original"}]);
    assert.equal(getApplyPatchRenderSnapshot("snapshot"), snapshot, "display does not rewrite owned state");
    assert.equal(view.renderCall(args, theme, {...context, expanded:false}), undefined, "compact preferences stay native");
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
