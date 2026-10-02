import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { McpServerSession } from "../../src/mcp/session.ts";
import { CatalogCache } from "../../src/mcp/catalog.ts";
import { startHttp } from "../helpers/mcp-server.mjs";

test("real stdio catalog stays lazy, shares connection, survives idle, and rejects obsolete schemas", async t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-mcp-")), log = join(dir, "wire.log"), schema = join(dir, "schema.json");
  writeFileSync(schema, '{"type":"integer"}');
  const entry = { name: "fixture", scope: "global", source: "fixture", config: { command: process.execPath,
    args: [fileURLToPath(new URL("../helpers/mcp-server.mjs", import.meta.url)), "stdio", log, schema] } };
  const ctx = { cwd: dir, isIdle: () => true, isProjectTrusted: () => true }, cache = new CatalogCache(dir);
  const make = () => new McpServerSession(entry, dir, dir, { enabled: true, idleTimeoutSeconds: 0.05, keepAliveServers: [] }, cache, () => ctx, () => {});
  const first = make(), second = make(); let slow;
  t.after(async () => { await Promise.all([first.shutdown(), second.shutdown(), slow?.shutdown()]); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(await first.restore(), false); await first.discover(true); await first.shutdown();
  assert.equal(await second.restore(), true);
  const events = () => readFileSync(log, "utf8").trim().split("\n");
  const starts = () => events().filter(line => line.startsWith("start:")).length;
  assert.equal(starts(), 1, "cache recovery starts no child process");
  const tool = second.catalog.tools[0], scope = second.scope;
  const values = await Promise.all([1, 2, 3].map(value => second.callTool(tool, scope, { value }, {})));
  assert.deepEqual(values.map(result => result.structuredContent.value), [1, 2, 3]); assert.equal(starts(), 2);
  const busy = second.callTool(second.catalog.tools[0], second.scope, { value: 4, delayMs: 150 }, {});
  await delay(90); assert.equal(second.state, "connected"); await busy;
  await delay(140); assert.equal(second.state, "disconnected");
  const old = second.catalog.tools[0], oldScope = second.scope;
  writeFileSync(schema, '{"type":"string"}');
  const before = events().filter(line => line.startsWith("call:")).length;
  await assert.rejects(second.callTool(old, oldScope, { value: 7 }, {}), /directory changed/);
  assert.equal(events().filter(line => line.startsWith("call:")).length, before, "obsolete arguments produce no server side effect");
  assert.equal((await second.callTool(second.catalog.tools[0], second.scope, { value: "007" }, {})).structuredContent.value, "007");
  await second.shutdown();
  for (const line of events().filter(line => line.startsWith("start:"))) assert.throws(() => process.kill(Number(line.slice(6)), 0), { code: "ESRCH" });
  await assert.rejects(second.callTool(old, oldScope, { value: 1 }, {}), /no longer active/);
  slow = new McpServerSession({ ...entry, config: { ...entry.config, args: [...entry.config.args, "3000"] } }, dir, dir,
    { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] }, cache, () => ctx, () => {});
  const initialized = events().filter(line => line === "initialize").length;
  const initializing = slow.discover();
  const rejected = assert.rejects(initializing);
  const deadline = Date.now() + 2000;
  while (events().filter(line => line === "initialize").length === initialized && Date.now() < deadline) await delay(20);
  assert.ok(events().filter(line => line === "initialize").length > initialized);
  await Promise.all([slow.shutdown(), slow.shutdown()]); await rejected;
  const pid = Number(events().filter(line => line.startsWith("start:")).at(-1).slice(6));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "shutdown awaits the first transport close and actual child exit");
});

test("cancelled initialization becomes idle and shutdown cannot publish a late catalog", async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-cancel-"));
  fixture.state.initializeDelay = 150;
  const owner = new McpServerSession({ name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } }, dir, dir,
    { enabled: true, idleTimeoutSeconds: 0.05, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {});
  t.after(async () => { await owner.shutdown(); await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const controller = new AbortController();
  const pending = owner.resource("resources/read", { uri: "data://plain" }, controller.signal);
  await delay(40); controller.abort(); await assert.rejects(pending);
  const deadline = Date.now() + 2000;
  while (!fixture.state.deleted && Date.now() < deadline) await delay(20);
  assert.equal(fixture.state.deleted, 1, "late initialization must still schedule idle close");
  fixture.state.initializeDelay = 300;
  const discovery = owner.discover(); await delay(40); await owner.shutdown();
  await assert.rejects(discovery); await delay(350);
  assert.equal(owner.state, "closed");
  assert.equal(fixture.state.calls, 0);
  await assert.rejects(owner.resource("resources/read", { uri: "data://plain" }));
});
