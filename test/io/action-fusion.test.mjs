import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeFusion, validateThenRun } from "../../vendor/pi-codex-conversion/src/tools/action-fusion.ts";
import { runNativeFusionCommand, runExecFusionCommand } from "../../vendor/pi-codex-conversion/src/tools/action-fusion-command.ts";
import { createExecSessionManager } from "../../vendor/pi-codex-conversion/src/tools/exec/session-manager.ts";
import actionFusion, { createNativeFusionTool } from "../../extensions/action-fusion.ts";
import { createApplyPatchTool } from "../../vendor/pi-codex-conversion/src/tools/apply-patch/tool.ts";
import { createNestedTools } from "../../vendor/pi-codex-conversion/src/adapter/code-mode.ts";
import { normalizeCodexConversionConfig } from "../../vendor/pi-codex-conversion/src/adapter/activation/config.ts";
import { createExecCommandTracker } from "../../vendor/pi-codex-conversion/src/tools/exec/command-state.ts";
import { toWireToolDefinition } from "../../vendor/pi-codex-conversion/src/tools/code-mode/host-protocol.ts";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "metis-fusion-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, isProjectTrusted: () => false, sessionManager: SessionManager.create(cwd, cwd) };
}
async function assertProcessStopped(pid) {
  const deadline = Date.now() + 2000;
  for (;;) {
    let state;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      state = stat.slice(stat.lastIndexOf(")") + 2);
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return; throw error; }
    if (/^[ZX] /.test(state)) return;
    if (Date.now() >= deadline) assert.fail(`child still executing after termination: ${state}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const mutation = () => ({ content: [{ type: "text", text: "Written" }], details: { status: "success" } });

test("native write freezes mutation diff before command rewrites the file; edit retains its own details", async (t) => {
  const ctx = fixture(t);
  const write = createNativeFusionTool("write", ctx.cwd);
  const result = await write.execute("write-one", { path: "file", content: "saved\n", then_run: { command: "printf changed > file; exit 4" } }, undefined, undefined, ctx);
  assert.equal(readFileSync(join(ctx.cwd, "file"), "utf8"), "changed");
  assert.equal(result.details.metisActionFusion.mutationStatus, "success");
  assert.equal(result.details.metisActionFusion.command.exitCode, 4);
  assert.equal(result.details.metisWriteDiff.kind, "add");
  assert.ok(result.details.metisWriteDiff.rows.some(row => row.content === "saved"));
  assert.ok(!result.details.metisWriteDiff.rows.some(row => row.content === "changed"));
  const edit = createNativeFusionTool("edit", ctx.cwd);
  const edited = await edit.execute("edit-one", { path: "file", edits: [{ oldText: "changed", newText: "edited" }], then_run: { command: "test $(cat file) = edited" } }, undefined, undefined, ctx);
  assert.equal(edited.details.metisActionFusion.command.status, "succeeded");
  assert.equal(typeof edited.details.diff, "string");
});

test("patch parameter aliases preserve then_run; partial patch skips follow-up", async (t) => {
  const ctx = fixture(t);
  let commands = 0;
  const patch = createApplyPatchTool({ runThenRun: () => async () => { commands++; return { status: "succeeded", exitCode: 0, output: "verified" }; } });
  const prepared = patch.prepareArguments({ patchText: "*** Begin Patch\n*** Add File: first\n+written\n*** End Patch", then_run: { command: "verify" } });
  assert.equal(prepared.then_run.command, "verify");
  const result = await patch.execute("patch-one", prepared, undefined, undefined, ctx);
  assert.equal(readFileSync(join(ctx.cwd, "first"), "utf8"), "written\n");
  assert.equal(result.details.metisActionFusion.command.status, "succeeded");
  const partial = await patch.execute("patch-partial", { input: "*** Begin Patch\n*** Add File: second\n+saved\n*** Update File: absent\n@@\n-no\n+yes\n*** End Patch", then_run: { command: "verify" } }, undefined, undefined, ctx);
  assert.equal(partial.details.metisActionFusion.command.status, "skipped");
  assert.equal(commands, 1);
  assert.equal(partial.details.metisActionFusion.mutationStatus, "partial_failure");
  assert.equal(readFileSync(join(ctx.cwd, "second"), "utf8"), "saved\n");
});

for (const executionMode of ["code", "notebook"]) test(`${executionMode} nested entry retains string patch and captures fused failure before throwing`, async (t) => {
  const ctx = fixture(t);
  const binary = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/exec/bin/linux-x64/exec_bridge", import.meta.url));
  const sessions = createExecSessionManager({ bridgeBinaryPath: () => binary });
  t.after(() => sessions.shutdown());
  const runtime = { state: { config: normalizeCodexConversionConfig(null), executionMode, availableToolNames: [] }, sessions, tracker: createExecCommandTracker() };
  const pi = { events: createEventBus(), on() {} };
  actionFusion(pi);
  const tools = createNestedTools(pi, runtime, ctx);
  const patch = tools.find(tool => tool.name === "apply_patch");
  const fused = tools.find(tool => tool.name === "apply_patch_then_run");
  assert.equal(toWireToolDefinition(patch).kind, "freeform");
  assert.equal(toWireToolDefinition(fused).kind, "function");
  assert.ok(toWireToolDefinition(fused).input_schema.properties.then_run);
  const wire = tools.map(toWireToolDefinition);
  runtime.state.executionMode = executionMode === "code" ? "notebook" : "code";
  assert.deepEqual(createNestedTools(pi, runtime, ctx).map(toWireToolDefinition), wire, "mode switches retain the shared declaration and order");
  const results = [];
  const context = { extensionContext: ctx, toolCallId: "nested", captureResult: result => results.push(result) };
  const signal = new AbortController().signal;
  await patch.invoke("*** Begin Patch\n*** Add File: old\n+old interface\n*** End Patch", context, signal);
  assert.equal(readFileSync(join(ctx.cwd, "old"), "utf8"), "old interface\n");
  await assert.rejects(fused.invoke({ input: "*** Begin Patch\n*** Add File: new\n+new interface\n*** End Patch", then_run: { command: "printf evidence; exit 9" } }, context, signal), /then_run:failed/);
  const result = results.at(-1);
  assert.equal(result.details.metisActionFusion.mutationStatus, "success");
  assert.equal(result.details.metisActionFusion.command.exitCode, 9);
  assert.equal(readFileSync(result.details.metisActionFusion.command.fullOutputPath, "utf8"), "evidence");
  assert.equal(readFileSync(join(ctx.cwd, "new"), "utf8"), "new interface\n");
});

for (const executionMode of ["code", "notebook"]) test(`${executionMode} without fusion keeps ordinary patch and omits the fused entry`, async t => {
  const ctx = fixture(t);
  const runtime = { state: { config: normalizeCodexConversionConfig(null), executionMode, availableToolNames: [] }, sessions: {}, tracker: createExecCommandTracker() };
  const tools = createNestedTools({ events: createEventBus() }, runtime, ctx);
  assert.equal(tools.some(tool => tool.name === "apply_patch_then_run"), false);
  const patch = tools.find(tool => tool.name === "apply_patch");
  assert.equal(toWireToolDefinition(patch).kind, "freeform");
  await patch.invoke("*** Begin Patch\n*** Add File: plain\n+ordinary patch\n*** End Patch", { extensionContext: ctx, toolCallId: "plain", captureResult() {} }, new AbortController().signal);
  assert.equal(readFileSync(join(ctx.cwd, "plain"), "utf8"), "ordinary patch\n");
});

test("disabled patch fusion rejects stale or injected then_run before changing files", async t => {
  const ctx = fixture(t);
  const patch = createApplyPatchTool();
  assert.equal(patch.parameters.properties.then_run, undefined);
  const input = "*** Begin Patch\n*** Add File: unexpected\n+must not be written\n*** End Patch";
  for (const key of ["input", "patchText", "patch"]) {
    assert.throws(() => patch.prepareArguments({ [key]: input, then_run: { command: "touch executed" } }), /Action Fusion is disabled/);
  }
  await assert.rejects(patch.execute("stale", { input, then_run: { command: "touch executed" } }, undefined, undefined, ctx), /Action Fusion is disabled/);
  assert.equal(existsSync(join(ctx.cwd, "unexpected")), false);
  assert.equal(existsSync(join(ctx.cwd, "executed")), false);
});

test("successful command runs once after mutation even if progress rendering fails", async (t) => {
  const ctx = fixture(t), path = join(ctx.cwd, "file");
  const result = await executeFusion({ paths: [path], thenRun: { command: "test -f file && printf verified >> receipt" },
    mutate: async () => { writeFileSync(path, "saved"); return mutation(); },
    run: (input, signal, update) => runNativeFusionCommand(input, ctx, signal, update),
    onUpdate() { throw new Error("renderer unavailable"); },
  });
  assert.equal(result.details.metisActionFusion.command.status, "succeeded");
  assert.equal(readFileSync(join(ctx.cwd, "receipt"), "utf8"), "verified");
});

test("patch move/delete paths share the command-duration queue with native path aliases", async (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.cwd, "source"), "before\n");
  writeFileSync(join(ctx.cwd, "deleted"), "obsolete\n");
  symlinkSync(ctx.cwd, join(ctx.cwd, "alias"), "dir");
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const patch = createApplyPatchTool({ runThenRun: () => async () => { enter(); await held; return { status: "succeeded", exitCode: 0, output: "checked" }; } });
  const first = patch.execute("move", { input: "*** Begin Patch\n*** Update File: source\n*** Move to: target\n@@\n-before\n+after\n*** Delete File: deleted\n*** End Patch", then_run: { command: "check" } }, undefined, undefined, ctx);
  t.after(() => release());
  await started;
  assert.equal(existsSync(join(ctx.cwd, "source")), false);
  assert.equal(existsSync(join(ctx.cwd, "deleted")), false);
  let complete = false;
  const second = createNativeFusionTool("write", ctx.cwd).execute("next", { path: "alias/target", content: "later" }, undefined, undefined, ctx).then(result => { complete = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(complete, false);
  assert.equal(readFileSync(join(ctx.cwd, "target"), "utf8"), "after\n");
  release(); await first; await second;
  assert.equal(readFileSync(join(ctx.cwd, "target"), "utf8"), "later");
});

test("invalid then_run cannot change files; absent then_run preserves mutation result", async (t) => {
  const ctx = fixture(t), path = join(ctx.cwd, "file");
  const result = mutation();
  for (const thenRun of [{ command: "" }, { command: "true", timeout: 0 }, { command: "true", timeout: Infinity }, { command: "true", extra: 1 }]) {
    await assert.rejects(executeFusion({ paths: [path], thenRun, mutate: async () => { writeFileSync(path, "bad"); return result; }, run: () => assert.fail("must not run") }));
    assert.equal(existsSync(path), false);
  }
  assert.equal(await executeFusion({ paths: [path], mutate: async () => result, run: () => assert.fail("must not run") }), result);
});

test("partial and failed mutations skip command without discarding evidence", async (t) => {
  const ctx = fixture(t);
  for (const partial of [true, false]) {
    const result = await executeFusion({ paths: [join(ctx.cwd, "file")], thenRun: { command: "false" },
      mutate: async () => { if (!partial) throw new Error("mutation failed"); return { ...mutation(), details: { status: "partial_failure", applied: ["one"] } }; },
      run: () => assert.fail("must not run"),
    });
    assert.equal(result.details.metisActionFusion.command.status, "skipped");
    assert.equal(result.details.metisActionFusion.mutationStatus, partial ? "partial_failure" : "failed");
    if (partial) assert.deepEqual(result.details.applied, ["one"]);
  }
});

test("native command retains exact Unicode output and nonzero status after successful mutation", async (t) => {
  const ctx = fixture(t), path = join(ctx.cwd, "file");
  const expected = "α🙂\n".repeat(12000);
  writeFileSync(join(ctx.cwd, "emit.mjs"), `process.stdout.write(${JSON.stringify(expected)}); process.exitCode=7;`);
  const result = await executeFusion({ paths: [path], thenRun: { command: "node emit.mjs" },
    mutate: async () => { writeFileSync(path, "saved"); return mutation(); },
    run: (input, signal, update) => runNativeFusionCommand(input, ctx, signal, update),
  });
  assert.equal(readFileSync(path, "utf8"), "saved");
  const receipt = result.details.metisActionFusion;
  assert.equal(receipt.mutationStatus, "success");
  assert.equal(receipt.command.status, "failed");
  assert.equal(receipt.command.exitCode, 7, receipt.command.error);
  assert.equal(readFileSync(receipt.command.fullOutputPath, "utf8"), expected);
  assert.ok(result.content[receipt.command.outputBlock].text.length < expected.length);
});

test("native explicit timeout and cancellation stop the command and retain prior output", async (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.cwd, "hang.mjs"), 'process.stdout.write("started\\n"); setTimeout(()=>require("fs"), 60000);');
  const timed = await runNativeFusionCommand({ command: "node hang.mjs", timeout: 0.3 }, ctx);
  assert.equal(timed.status, "timed_out", timed.error);
  assert.equal(readFileSync(timed.fullOutputPath, "utf8"), "started\n");
  const controller = new AbortController();
  const running = runNativeFusionCommand({ command: "node hang.mjs" }, ctx, controller.signal, (result) => { if (result.output.includes("started")) controller.abort(); });
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(readFileSync(cancelled.fullOutputPath, "utf8"), "started\n");
});

test("overlapping mutations wait through command; queued cancellation performs no mutation", async (t) => {
  const ctx = fixture(t), path = join(ctx.cwd, "file");
  let release, entered;
  const started = new Promise(r => { entered = r; });
  const pending = new Promise(r => { release = r; });
  const first = executeFusion({ paths: [path], thenRun: { command: "test" }, mutate: async () => mutation(), run: async () => { entered(); await pending; return { status: "succeeded", output: "ok", exitCode: 0 }; } });
  await started;
  const controller = new AbortController();
  const second = executeFusion({ paths: [path], signal: controller.signal, mutate: () => assert.fail("cancelled mutation"), run: () => assert.fail("cancelled command") });
  controller.abort();
  await assert.rejects(second, /abort/i);
  release(); await first;
  assert.equal(validateThenRun({ command: "true", timeout: 1 }).timeout, 1);
});

test("conversion command archives output on exit, timeout and cancellation and leaves no running process", { timeout: 15000 }, async (t) => {
  const ctx = fixture(t);
  const binary = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/exec/bin/linux-x64/exec_bridge", import.meta.url));
  const sessions = createExecSessionManager({ bridgeBinaryPath: () => binary, minNonInteractiveExecYieldTimeMs: 250 });
  t.after(() => sessions.shutdown());
  writeFileSync(join(ctx.cwd, "emit.mjs"), 'process.stdout.write("original🙂\\n"); process.exitCode=3;');
  const failed = await runExecFusionCommand(sessions, { command: "node emit.mjs" }, ctx);
  assert.equal(failed.status, "failed", failed.error);
  assert.equal(failed.exitCode, 3);
  assert.equal(readFileSync(failed.fullOutputPath, "utf8"), "original🙂\n");
  writeFileSync(join(ctx.cwd, "hang.mjs"), 'import{writeFileSync}from"node:fs";writeFileSync("pid",String(process.pid));process.stdout.write("started\\n");setInterval(()=>{},1000);');
  const timed = await runExecFusionCommand(sessions, { command: "node hang.mjs", timeout: 0.4 }, ctx);
  assert.equal(timed.status, "timed_out", timed.error);
  assert.equal(readFileSync(timed.fullOutputPath, "utf8"), "started\n");
  await assertProcessStopped(Number(readFileSync(join(ctx.cwd, "pid"), "utf8")));
  const controller = new AbortController();
  const cancelled = await runExecFusionCommand(sessions, { command: "node hang.mjs" }, ctx, controller.signal, result => { if (result.output.includes("started")) controller.abort(); });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(readFileSync(cancelled.fullOutputPath, "utf8"), "started\n");
  await assertProcessStopped(Number(readFileSync(join(ctx.cwd, "pid"), "utf8")));
  assert.equal(sessions.listSessions().length, 0);
});
