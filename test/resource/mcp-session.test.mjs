import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { McpServerSession } from "../../src/mcp/session.ts";
import { CatalogCache } from "../../src/mcp/catalog.ts";
import { startHttp } from "../helpers/mcp-server.mjs";

test("HTTP rechecks the approved tool after asynchronous auth headers and before dispatch", async t => {
  for (const change of ["unchanged", "schema", "annotations", "scope", "cancel", "session", "pending", "notice", "failure"]) await t.test(change, async () => {
    const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-dispatch-"));
    let armed = false, providerCalls = 0, token = "synthetic-token", currentCwd = dir, enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let enterRefresh, releaseRefresh;
    const refreshEntered = new Promise(resolve => { enterRefresh = resolve; });
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const context = { isIdle: () => true, isProjectTrusted: () => true,
      get cwd() { return currentCwd; },
      modelRegistry: { async getApiKeyForProvider() {
        // Identity checks first; the SDK then awaits token() before sending HTTP.
        if (armed) {
          if (++providerCalls === 2) { enter(); await gate; }
          else if (change === "notice" && providerCalls === 3) { enterRefresh(); await refreshGate; }
        }
        return token;
      } },
    };
    const owner = new McpServerSession({ name: "fixture", scope: "global", source: "fixture", config: {
      url: fixture.url, auth: { provider: "synthetic" },
    } }, dir, dir, { enabled: true, idleTimeoutSeconds: 60, keepAliveServers: [] }, new CatalogCache(dir),
      () => context, () => {});
    const controller = new AbortController();
    let pending, refresh;
    try {
      await owner.discover();
      const old = owner.catalog.tools[0], oldScope = owner.scope;
      armed = true;
      pending = owner.callTool(old, oldScope, { value: 1 }, { signal: controller.signal });
      const outcome = pending.then(result => ({ result }), error => ({ error }));
      await Promise.race([entered, delay(2_000, undefined, { ref: false }).then(() => { throw new Error("SDK header token await was not reached"); })]);
      assert.equal(fixture.state.calls, 0, "auth headers are gated before any tools/call reaches the server");
      let approvedCalls = change === "unchanged" ? 1 : 0;
      if (change === "schema") {
        fixture.state.type = "string"; await owner.discover(true);
        assert.equal(owner.catalog.tools[0].inputSchema.properties.value.type, "string");
        const fresh = await owner.callTool(owner.catalog.tools[0], owner.scope, { value: "fresh" }, {});
        assert.equal(fresh.structuredContent.value, "fresh", "concurrent current definition has its own guard");
        approvedCalls++;
      } else if (change === "annotations") {
        fixture.state.annotations = { readOnlyHint: false }; await owner.discover(true);
        assert.equal(owner.catalog.tools[0].annotations.readOnlyHint, false);
      } else if (change === "scope") {
        token = "synthetic-account-two"; await owner.discover(true);
        assert.notEqual(owner.scope, oldScope);
      } else if (change === "pending" || change === "notice") {
        fixture.state.type = "string";
        if (change === "pending") {
          fixture.state.onList = async () => { enterRefresh(); await refreshGate; };
          refresh = owner.discover();
        } else fixture.notify();
        await Promise.race([refreshEntered, delay(2_000, undefined, { ref: false }).then(() => {
          throw new Error("actual directory refresh did not reach its gate");
        })]);
        assert.equal(owner.catalog.tools[0].inputSchema.properties.value.type, "integer", "changed directory has not committed yet");
      } else if (change === "failure") {
        fixture.state.type = "string";
        fixture.state.onList = () => { throw new Error("synthetic-list-failure"); };
        await assert.rejects(owner.discover());
      } else if (change === "cancel") controller.abort();
      else if (change === "session") currentCwd = join(dir, "other-session");
      release();
      const finished = await outcome;
      if (change === "unchanged") assert.equal(finished.result.structuredContent.value, 1);
      else assert.ok(finished.error, "changed approval must reject the pending call");
      // Also drain the SDK's asynchronous send after cancellation rejects the client request.
      await delay(20);
      assert.equal(fixture.state.calls, approvedCalls, "only current approved calls have remote side effects");
      if (change === "pending" || change === "notice" || change === "failure") {
        releaseRefresh(); fixture.state.onList = undefined;
        if (change === "pending") await refresh;
        else if (change === "failure") await owner.discover();
        else {
          const deadline = Date.now() + 2_000;
          while (owner.catalog.tools[0].inputSchema.properties.value.type !== "string" && Date.now() < deadline) await delay(10);
        }
        assert.equal(owner.catalog.tools[0].inputSchema.properties.value.type, "string");
        assert.equal((await owner.callTool(owner.catalog.tools[0], owner.scope, { value: "current" }, {})).structuredContent.value, "current");
        assert.equal(fixture.state.calls, 1, "successful directory refresh re-enables current approved tools");
      }
    } finally {
      release(); releaseRefresh(); fixture.state.onList = undefined;
      await refresh?.catch(() => {}); await pending?.catch(() => {});
      await owner.shutdown(); await fixture.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("command credentials renew on refresh and reconnect while old requests finish", { skip: process.platform === "win32" }, async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-command-"));
  const token = join(dir, "token"), resolver = join(dir, "resolve.cjs"), log = join(dir, "resolutions");
  writeFileSync(token, "Bearer synthetic-one");
  writeFileSync(resolver, 'const fs = require("node:fs"); fs.appendFileSync(process.argv[3], "resolved\\n"); process.stdout.write(fs.readFileSync(process.argv[2], "utf8"));');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = "!" + [process.execPath, resolver, token, log].map(quote).join(" ");
  const originalFetch = globalThis.fetch, observed = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === fixture.url && typeof init?.body === "string" && JSON.parse(init.body).method === "initialize")
      observed.push(new Headers(init.headers).get("authorization"));
    return originalFetch(input, init);
  };
  const owner = new McpServerSession({ name: "fixture", scope: "global", source: "fixture", config: {
    url: fixture.url, headers: { Authorization: command },
  } }, dir, dir, { enabled: true, idleTimeoutSeconds: 60, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {});
  t.after(async () => {
    try { await owner.shutdown(); await fixture.close(); }
    finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
  });
  assert.equal(await owner.restore(), false);
  assert.equal(existsSync(log), false, "cache identity does not run a credential command");
  await owner.discover();
  const oldTool = owner.catalog.tools[0], oldScope = owner.scope;
  const pending = owner.callTool(oldTool, oldScope, { value: 1, delayMs: 250 }, {});
  const deadline = Date.now() + 2_000;
  while (!fixture.state.calls && Date.now() < deadline) await delay(10);
  assert.equal(fixture.state.calls, 1, "the old connection has a real in-flight request");
  writeFileSync(token, "Bearer synthetic-two");
  await owner.refresh();
  assert.equal((await pending).structuredContent.value, 1, "refresh does not close a leased old connection");
  assert.deepEqual(observed, ["Bearer synthetic-one", "Bearer synthetic-two"]);
  const before = fixture.state.calls;
  await assert.rejects(owner.callTool(oldTool, oldScope, { value: 2 }, {}), /directory changed/);
  assert.equal(fixture.state.calls, before, "rotated credentials reject an old definition without a remote side effect");
  assert.equal((await owner.callTool(owner.catalog.tools[0], owner.scope, { value: 2 }, {})).structuredContent.value, 2);
  writeFileSync(token, "Bearer synthetic-three");
  await owner.suspend(); await owner.discover();
  assert.deepEqual(observed, ["Bearer synthetic-one", "Bearer synthetic-two", "Bearer synthetic-three"]);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3, "resolve exactly once for each transport");
});

test("real stdio catalog stays lazy, shares connection, survives idle, and rejects obsolete schemas", async t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-mcp-")), log = join(dir, "wire.log"), schema = join(dir, "schema.json");
  writeFileSync(schema, '{"type":"integer"}');
  const entry = { name: "fixture", scope: "global", source: "fixture", config: { command: process.execPath,
    args: [fileURLToPath(new URL("../helpers/mcp-server.mjs", import.meta.url)), "stdio", log, schema] } };
  const ctx = { cwd: dir, isIdle: () => true, isProjectTrusted: () => true }, cache = new CatalogCache(dir);
  const make = () =>
    new McpServerSession(
      entry,
      dir,
      dir,
      { enabled: true, idleTimeoutSeconds: 0.05, keepAliveServers: [] },
      cache,
      () => ctx,
      () => {},
    );
  const first = make(),
    second = make();
  let slow;
  t.after(async () => {
    await Promise.all([first.shutdown(), second.shutdown(), slow?.shutdown()]);
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await first.restore(), false);
  await first.discover(true);
  await first.shutdown();
  const key = cache.fingerprint(entry, dir, true, undefined);
  const historical = { ...cache.read(key),
    resources: [{ uri: "data://old", name: "old", mimeType: "text/plain" }],
    resourceTemplates: [{ uriTemplate: "data://{name}", name: "old" }],
  };
  await cache.write(key, historical, Date.now(), () => true);
  assert.equal(await second.restore(), true);
  assert.deepEqual(second.catalog.resources, historical.resources, "existing version-1 resource catalogs still restore");
  assert.deepEqual(second.catalog.resourceTemplates, historical.resourceTemplates);
  const events = () => readFileSync(log, "utf8").trim().split("\n");
  const starts = () => events().filter((line) => line.startsWith("start:")).length;
  assert.equal(starts(), 1, "cache recovery starts no child process");
  const tool = second.catalog.tools[0],
    scope = second.scope;
  const values = await Promise.all([1, 2, 3].map((value) => second.callTool(tool, scope, { value }, {})));
  assert.deepEqual(
    values.map((result) => result.structuredContent.value),
    [1, 2, 3],
  );
  assert.equal(starts(), 2);
  const busy = second.callTool(second.catalog.tools[0], second.scope, { value: 4, delayMs: 150 }, {});
  await delay(90);
  assert.equal(second.state, "connected");
  await busy;
  await delay(140);
  assert.equal(second.state, "disconnected");
  const old = second.catalog.tools[0],
    oldScope = second.scope;
  writeFileSync(schema, '{"type":"string"}');
  const before = events().filter((line) => line.startsWith("call:")).length;
  await assert.rejects(second.callTool(old, oldScope, { value: 7 }, {}), /directory changed/);
  assert.equal(
    events().filter((line) => line.startsWith("call:")).length,
    before,
    "obsolete arguments produce no server side effect",
  );
  assert.equal(
    (await second.callTool(second.catalog.tools[0], second.scope, { value: "007" }, {})).structuredContent.value,
    "007",
  );
  await second.shutdown();
  for (const line of events().filter((line) => line.startsWith("start:")))
    assert.throws(() => process.kill(Number(line.slice(6)), 0), { code: "ESRCH" });
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
