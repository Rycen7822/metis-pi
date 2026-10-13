import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { validateToolArguments } from "@earendil-works/pi-ai";
import lsp from "../../extensions/lsp.ts";
import { DEFAULT_SERVER_CONFIGS, loadConfig } from "../../src/pi-lsp/config.ts";
import { loadRuntime } from "../../src/pi-lsp/adapters.ts";
import { createMockContext, createMockPi } from "./host.ts";

function workspace(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "metis-lsp-entry-")), agent = join(root, "agent"), project = join(root, "project");
  mkdirSync(agent); mkdirSync(project);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(agent, "metis-pi.toml");
  return { root, agent, project, path, save: (lsp: unknown) => writeFileSync(path, stringify({ lsp })) };
}

test("owned entry exposes only the compact direct LSP tool and retains command/lifecycle hooks", async t => {
  const w = workspace(t), host = createMockPi(); w.save({ servers: {} }); lsp(host.pi);
  assert.deepEqual(host.tools.map(tool => tool.name), ["lsp"]);
  const tool = host.tools[0];
  assert.ok(tool.exposure === undefined || tool.exposure === "direct");
  assert.deepEqual(tool.parameters.properties.action.enum, ["diagnostics", "fix"]);
  assert.deepEqual([...host.commands.keys()], ["lsp"]);
  assert.deepEqual([...host.events.keys()].sort(), ["session_shutdown", "session_start"]);
  assert.doesNotMatch(JSON.stringify(tool.promptGuidelines), /lsp_diagnostics|lsp_fix|pi-lsp\.json/);
  const { ctx, notifications } = createMockContext({ cwd: w.project });
  const invalidArguments: Record<string, string>[] = [{}, { action: "unknown" }];
  for (const args of invalidArguments) {
    assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: "lsp", arguments: args }), /action/);
  }
  await assert.rejects(tool.execute("invalid", { action: "unknown" }, undefined, undefined, ctx), /action/);
  await assert.rejects(tool.execute("missing", { action: "fix" }, undefined, undefined, ctx), /requires path/);
  await assert.rejects(tool.execute("array", { action: "fix", path: "main.go", server: ["a"] }, undefined, undefined, ctx), /one server/);
  const before = readFileSync(w.path, "utf8");
  await host.commands.get("lsp").handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.equal(readFileSync(w.path, "utf8"), before);
});

test("global TOML alone owns LSP configuration, reloads preferences, and ignores legacy/project JSON", t => {
  const w = workspace(t);
  writeFileSync(join(w.agent, "pi-lsp.json"), "invalid legacy config");
  writeFileSync(join(w.agent, "lsp.json"), "invalid legacy config");
  writeFileSync(join(w.agent, "settings.json"), "invalid unrelated legacy config");
  mkdirSync(join(w.project, ".pi"));
  writeFileSync(join(w.project, ".pi/pi-lsp.json"), "invalid project config");
  writeFileSync(join(w.project, ".pi/metis-pi.toml"), "[broken");
  const defaults = loadRuntime();
  assert.equal(defaults.timeoutMs, 20000);
  assert.equal(defaults.adapters.length, DEFAULT_SERVER_CONFIGS.length);
  assert.ok(defaults.adapters.every(adapter => adapter.isDefault));
  const custom = { timeout: 30000, servers: { fixture: {
    command: [process.execPath, "--stdio"], extensions: ["ts"], env: { EXAMPLE: "from-env" },
    initialization: { nested: { enabled: true } }, skipDirectories: ["generated"],
    diagnosticsSettleMs: 25, pushDiagnosticsGraceMs: 30, pullDiagnosticsGraceMs: 35,
  } } };
  w.save(custom);
  const snapshot = readFileSync(w.path, "utf8"), runtime = loadRuntime();
  assert.equal(runtime.timeoutMs, 30000); assert.equal(runtime.adapters.length, 1);
  const adapter = runtime.adapters[0]!;
  assert.equal(adapter.isDefault, false);
  assert.deepEqual(adapter.defaultCommand, { command: process.execPath, args: ["--stdio"] });
  assert.deepEqual(adapter.extensions, [".ts"]); assert.deepEqual({ ...adapter.env }, custom.servers.fixture.env);
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.initialization)), custom.servers.fixture.initialization);
  assert.ok(adapter.skipDirectories.has("generated")); assert.equal(adapter.diagnosticsSettleMs, 25);
  assert.equal(adapter.pushDiagnosticsGraceMs, 30); assert.equal(adapter.pullDiagnosticsGraceMs, 35);
  assert.match(adapter.missingCommandHint, /metis-pi\.toml/);
  assert.equal(readFileSync(w.path, "utf8"), snapshot);
  w.save({ timeout: 5000, servers: {} });
  assert.equal(loadRuntime().timeoutMs, 5000); assert.deepEqual(loadRuntime().adapters, []);
  writeFileSync(w.path, "[broken");
  assert.throws(loadRuntime, /invalid TOML/);
  assert.equal(readFileSync(join(w.agent, "pi-lsp.json"), "utf8"), "invalid legacy config");
});

test("grouped actions use context cwd, multi-server diagnostics and exact preview/kind/write semantics", async t => {
  const w = workspace(t), host = createMockPi(), log = join(w.root, "events.jsonl");
  const command = [process.execPath, fileURLToPath(new URL("./fixtures/diagnostics-server.mjs", import.meta.url)), "lifecycle-normal"];
  const server = { command, extensions: [".go"], env: { PI_LSP_TEST_LOG: log } };
  w.save({ timeout: 1000, servers: { first: server, second: server } });
  writeFileSync(join(w.project, "main.go"), "package main\n");
  lsp(host.pi); const tool = host.tools[0], { ctx } = createMockContext({ cwd: w.project });
  const diagnostics = await tool.execute("diagnostics", { action: "diagnostics", paths: ["main.go"], server: ["first", "second"] }, undefined, undefined, ctx);
  assert.equal(diagnostics.details.root, w.project);
  assert.deepEqual(diagnostics.details.routes.map((route: any) => route.server), ["first", "second"]);
  await assert.rejects(tool.execute("ambiguous", { action: "fix", path: "main.go" }, undefined, undefined, ctx), /Multiple LSP servers/);
  const args = { action: "fix", path: "main.go", server: "first" };
  const preview = await tool.execute("preview", args, undefined, undefined, ctx);
  assert.equal(preview.details.kind, "source.fixAll"); assert.equal(preview.details.write, false);
  assert.equal(preview.details.text, "// fixed\npackage main\n");
  assert.equal(readFileSync(join(w.project, "main.go"), "utf8"), "package main\n");
  const explicit = await tool.execute("kind", { ...args, kind: "source.organizeImports" }, undefined, undefined, ctx);
  assert.equal(explicit.details.kind, "source.organizeImports"); assert.equal(explicit.details.changed, false);
  const events = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.method === "textDocument/codeAction" && event.params.context.only[0] === "source.organizeImports"));
  const written = await tool.execute("write", { ...args, write: true }, undefined, undefined, ctx);
  assert.equal(written.details.write, true); assert.equal(readFileSync(join(w.project, "main.go"), "utf8"), preview.details.text);
});

test("LSP TOML validation rejects invalid fields instead of falling back to commands", t => {
  const w = workspace(t);
  for (const value of [false, { timeout: 0 }, { timeout: "30000" }, { servers: [] },
    { servers: { fixture: { command: [process.execPath], extensions: [".go"], env: { KEY: 1 } } } },
    { servers: { fixture: { command: [process.execPath], extensions: [".go"], skipDirectories: ["../escape"] } } },
    { servers: { fixture: { command: [process.execPath], extensions: [".go"], initialization: [] } } },
    { servers: { fixture: { command: [process.execPath], extensions: [".go"], pullDiagnosticsGraceMs: 0 } } }]) {
    w.save(value); assert.throws(loadRuntime);
  }
  writeFileSync(w.path, "lsp = 2026-10-08\n");
  assert.throws(loadRuntime, /must be a table/);
  writeFileSync(w.path, "[lsp]\nservers = 2026-10-08\n");
  assert.throws(loadRuntime, /servers must be a table/);
  w.save({ servers: { empty: { command: [], extensions: [".go"] } } });
  assert.throws(loadRuntime, /at least one string/);
  assert.equal(loadConfig().servers.length, 1);
});
