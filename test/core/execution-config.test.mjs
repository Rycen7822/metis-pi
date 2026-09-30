import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readExecutionConfig, writeExecutionConfig, executionConfigPath } from "../../src/execution/config.ts";

test("execution overlays honor trust and writing one scope does not copy inherited siblings", t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-execution-config-")), cwd = join(dir, "project");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  const global = executionConfigPath(), project = executionConfigPath(cwd);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(global, JSON.stringify({ enabled: false, extensionOption: 7, execution: { tools: { customRustBinariesDir: "/global/bin", future: "keep" } } }));
  writeFileSync(project, JSON.stringify({ execution: { tools: { customRustBinariesDir: "/project/bin" } } }));
  const context = trusted => ({ cwd, isProjectTrusted: () => trusted });
  assert.equal(readExecutionConfig(context(false)).tools.customRustBinariesDir, "/global/bin");
  assert.equal(readExecutionConfig(context(true)).tools.customRustBinariesDir, "/project/bin");
  writeExecutionConfig({ ui: { toolRenaming: true } });
  const saved = JSON.parse(readFileSync(global, "utf8"));
  assert.equal(saved.execution.tools.customRustBinariesDir, "/global/bin");
  assert.equal(saved.execution.tools.future, "keep");
  assert.equal(saved.execution.ui.toolRenaming, true);
  assert.equal(saved.enabled, false); assert.equal(saved.extensionOption, 7);
  writeExecutionConfig({ tools: { viewImageFallback: true } }, cwd);
  assert.equal(readExecutionConfig(context(true)).tools.viewImageFallback, true);
  assert.equal(readExecutionConfig(context(false)).tools.viewImageFallback, false);
});
