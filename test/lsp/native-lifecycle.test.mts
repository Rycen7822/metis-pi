// Derived from pi-lsp 0.49.9 (55d7847); MIT copyright 2026 narumiruna.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { stringify } from "smol-toml";
import { fixture } from "./lifecycle-support.ts";

for (const kind of ["diagnostics", "fix"] as const) {
  test(`owned ${kind}: native runner drains active work before stale-context invalidation`, async () => {
    const f = fixture(kind === "fix" ? "lifecycle-hang-textDocument/codeAction" : "lifecycle-hang-initialize");
    const agentDir = path.join(f.root, "agent");
    mkdirSync(agentDir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "metis-pi.toml"),
      stringify({ lsp: {
        timeout: 1_000,
        servers: {
          fixture: {
            command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args],
            extensions: [".go"],
            env: f.adapter.env,
          },
        },
      } }),
    );
    let runner: ExtensionRunner | undefined;
    let invalidated = false;
    try {
      const loader = new DefaultResourceLoader({
        cwd: f.root,
        agentDir,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true,
        noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/lsp.ts", import.meta.url))],
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        f.root,
        SessionManager.inMemory(f.root),
        {} as ModelRegistry,
      );
      const errors: unknown[] = [];
      runner.onError((error) => {
        errors.push(error);
      });
      await runner.emit({ type: "session_start", reason: "startup" });
      const ctx = runner.createToolContext("test", f.controller.signal);
      const tool = runner.getToolDefinition("lsp");
      assert.ok(tool);
      const task = f.track(
        tool.execute(
          "test",
          { action: kind, root: f.root, path: "main.go", paths: ["main.go"], write: true },
          f.controller.signal,
          undefined,
          ctx,
        ),
      );
      await f.ready(kind === "fix" ? "textDocument/codeAction" : "initialize");
      await runner.emit({ type: "session_shutdown", reason: "reload" });
      f.exited();
      runner.invalidate();
      invalidated = true;
      assert.throws(() => ctx.ui, /stale/);
      await assert.rejects(task, /aborted|cancelled/);
      assert.deepEqual(errors, []);
    } finally {
      f.controller.abort();
      if (runner && !invalidated) await runner.emit({ type: "session_shutdown", reason: "quit" });
      await f.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
}
