import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFusion, validateThenRun } from "../../src/execution/action-fusion.ts";
import { runNativeFusionCommand } from "../../src/execution/action-fusion-command.ts";
import { createNativeFusionTool } from "../../extensions/action-fusion.ts";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "metis-fusion-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, isProjectTrusted: () => false, sessionManager: SessionManager.create(cwd, cwd) };
}
const mutation = () => ({ content: [{ type: "text", text: "Written" }], details: { status: "success" } });

test("native write freezes mutation diff before command rewrites the file; edit retains its own details", async (t) => {
  const ctx = fixture(t);
  const write = createNativeFusionTool("write", ctx.cwd);
  const result = await write.execute(
    "write-one",
    { path: "file", content: "saved\n", then_run: { command: "printf changed > file; exit 4" } },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(readFileSync(join(ctx.cwd, "file"), "utf8"), "changed");
  assert.equal(result.details.metisActionFusion.mutationStatus, "success");
  assert.equal(result.details.metisActionFusion.command.exitCode, 4);
  assert.equal(result.details.metisWriteDiff.kind, "add");
  assert.ok(result.details.metisWriteDiff.rows.some((row) => row.content === "saved"));
  assert.ok(!result.details.metisWriteDiff.rows.some((row) => row.content === "changed"));
  const edit = createNativeFusionTool("edit", ctx.cwd);
  const edited = await edit.execute(
    "edit-one",
    {
      path: "file",
      edits: [{ oldText: "changed", newText: "edited" }],
      then_run: { command: "test $(cat file) = edited" },
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(edited.details.metisActionFusion.command.status, "succeeded");
  assert.equal(typeof edited.details.diff, "string");
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

test("invalid then_run cannot change files; absent then_run preserves mutation result", async (t) => {
  const ctx = fixture(t),
    path = join(ctx.cwd, "file");
  const result = mutation();
  for (const thenRun of [
    { command: "" },
    { command: "true", timeout: 0 },
    { command: "true", timeout: Infinity },
    { command: "true", extra: 1 },
  ]) {
    await assert.rejects(
      executeFusion({
        paths: [path],
        thenRun,
        mutate: async () => {
          writeFileSync(path, "bad");
          return result;
        },
        run: () => assert.fail("must not run"),
      }),
    );
    assert.equal(existsSync(path), false);
  }
  assert.equal(
    await executeFusion({ paths: [path], mutate: async () => result, run: () => assert.fail("must not run") }),
    result,
  );
});

test("partial and failed mutations skip command without discarding evidence", async (t) => {
  const ctx = fixture(t);
  for (const partial of [true, false]) {
    const result = await executeFusion({
      paths: [join(ctx.cwd, "file")],
      thenRun: { command: "false" },
      mutate: async () => {
        if (!partial) throw new Error("mutation failed");
        return { ...mutation(), details: { status: "partial_failure", applied: ["one"] } };
      },
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
  const running = runNativeFusionCommand({ command: "node hang.mjs" }, ctx, controller.signal, (result) => {
    if (result.output.includes("started")) controller.abort();
  });
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(readFileSync(cancelled.fullOutputPath, "utf8"), "started\n");
});

test("overlapping mutations wait through command; queued cancellation performs no mutation", async (t) => {
  const ctx = fixture(t),
    path = join(ctx.cwd, "file");
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const pending = new Promise((r) => {
    release = r;
  });
  const first = executeFusion({
    paths: [path],
    thenRun: { command: "test" },
    mutate: async () => mutation(),
    run: async () => {
      entered();
      await pending;
      return { status: "succeeded", output: "ok", exitCode: 0 };
    },
  });
  await started;
  const controller = new AbortController();
  const second = executeFusion({
    paths: [path],
    signal: controller.signal,
    mutate: () => assert.fail("cancelled mutation"),
    run: () => assert.fail("cancelled command"),
  });
  controller.abort();
  await assert.rejects(second, /abort/i);
  release();
  await first;
  assert.equal(validateThenRun({ command: "true", timeout: 1 }).timeout, 1);
});
