import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readExecutionConfig, writeExecutionConfig, executionConfigPath } from "../../src/execution/config.ts";
import { parseMetisConfig } from "../../src/metis-config.ts";

test("execution is global only and section writes preserve other values", t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-execution-config-")), cwd = join(dir, "project");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const global = executionConfigPath();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(global, '[appearance]\nenabled=false\n[future]\nvalue=7\n[execution.tools]\ncustomRustBinariesDir="/global/bin"\nfuture="keep"\n');
  writeFileSync(join(cwd, ".pi", "metis-pi.toml"), '[execution.tools]\ncustomRustBinariesDir="/project/bin"\nviewImageFallback=true\n');
  writeFileSync(join(cwd, ".pi", "metis-pi.json"), JSON.stringify({ execution: { tools: { customRustBinariesDir: "/legacy/project/bin" } } }));
  const context = trusted => ({ cwd, isProjectTrusted: () => trusted });
  assert.equal(readExecutionConfig(context(false)).tools.customRustBinariesDir, "/global/bin");
  assert.equal(readExecutionConfig(context(true)).tools.customRustBinariesDir, "/global/bin");
  assert.equal(readExecutionConfig(context(true)).tools.viewImageFallback, false);
  writeExecutionConfig({ ui: { toolRenaming: true } });
  const saved = parseMetisConfig(readFileSync(global, "utf8"));
  assert.equal(saved.execution.tools.customRustBinariesDir, "/global/bin");
  assert.equal(saved.execution.tools.future, "keep");
  assert.equal(saved.execution.ui.toolRenaming, true);
  assert.equal(saved.appearance.enabled, false); assert.equal(saved.future.value, 7);
  writeExecutionConfig({ tools: { viewImageFallback: true } });
  assert.equal(readExecutionConfig(context(true)).tools.viewImageFallback, true);
  assert.equal(readExecutionConfig(context(false)).tools.viewImageFallback, true);
});
