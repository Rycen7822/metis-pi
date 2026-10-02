import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { McpServerSession } from "../../src/mcp/session.ts";
import { CatalogCache } from "../../src/mcp/catalog.ts";
import { McpCredentials, createAuth } from "../../src/mcp/auth.ts";
import { convertResult } from "../../src/mcp/tools.ts";
import { startHttp, image } from "../helpers/mcp-server.mjs";
const run = promisify(execFile), cli = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));

test("HTTP preserves result/images, filters Apps, retries only expired sessions and observes live catalog changes", async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-http-"));
  const owner = new McpServerSession({ name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } }, dir, dir,
    { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {});
  t.after(async () => { await owner.shutdown(); await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  await owner.discover();
  const result = await convertResult("fixture", "echo", await owner.callTool(owner.catalog.tools[0], owner.scope, { value: 1, domainError: true }, {}));
  assert.equal(result.isError, true); assert.equal(result.structuredContent.structuredContent.value, 1);
  assert.equal(result.content.find(block => block.type === "image").data, image);
  assert.doesNotMatch(JSON.stringify(result), /UI_SECRET|ui:\/\/panel/);
  fixture.state.expire = true;
  const before = fixture.state.calls;
  await owner.callTool(owner.catalog.tools[0], owner.scope, { value: 2 }, {});
  assert.equal(fixture.state.calls, before + 1); assert.equal(fixture.state.starts, 2);
  fixture.state.fail = true;
  await assert.rejects(owner.callTool(owner.catalog.tools[0], owner.scope, { value: 3 }, {}));
  assert.equal(fixture.state.calls, before + 2, "failure after execution must not replay the call");
  fixture.state.fail = false; fixture.state.type = "string"; fixture.notify();
  const deadline = Date.now() + 2000;
  while (owner.catalog.tools[0].inputSchema.properties.value.type !== "string" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(owner.catalog.tools[0].inputSchema.properties.value.type, "string");
});

test("native CLI and Metis share OAuth rotation locks, while logout wins over a late refresh", { skip: process.platform === "win32" }, async t => {
  const fixture = await startHttp({ oauth: true }), dir = mkdtempSync(join(tmpdir(), "metis-mcp-oauth-"));
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(join(dir, "bin"));
  const browser = '#!/usr/bin/env node\nfetch(process.argv[2]).catch(() => process.exit(1));\n';
  for (const name of ["xdg-open", "open"]) writeFileSync(join(dir, "bin", name), browser, { mode: 0o700 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PATH: join(dir, "bin") + delimiter + process.env.PATH };
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: fixture.url } } }));
  const command = (...args) => run(process.execPath, [cli, "mcp", ...args], { cwd: dir, env, timeout: 15000 });
  const loggedIn = await command("login", "fixture", "--timeout", "8"); assert.match(loggedIn.stdout, /Signed in/);
  const entry = { name: "fixture", config: { url: fixture.url }, source: "fixture", scope: "global" };
  const store = new McpCredentials(dir, entry), auth = createAuth(entry, store), path = join(dir, "mcp-auth.json");
  const expire = () => { const state = JSON.parse(readFileSync(path, "utf8")); state[store.key].tokensExpireAt = 0; writeFileSync(path, JSON.stringify(state)); };
  expire(); fixture.state.refreshDelay = 1000;
  let begun; const started = new Promise(resolve => { begun = resolve; }); fixture.state.onRefresh = begun;
  const token = auth.token(); await started;
  const listed = command("list"); const [value, listing] = await Promise.all([token, listed]);
  assert.equal(value, "access-2"); assert.match(listing.stdout, /fixture/); assert.equal(fixture.state.refreshes, 1);
  assert.equal((await store.load()).tokens.refresh_token, "refresh-2");
  expire(); fixture.state.refreshDelay = 1500;
  let next; const refreshing = new Promise(resolve => { next = resolve; }); fixture.state.onRefresh = next;
  const pending = auth.token(); await refreshing; await command("logout", "fixture"); await pending;
  assert.equal(await store.load(), undefined, "late refresh must not recreate logged-out credentials");
  await command("login", "fixture", "--timeout", "8");
  const owner = new McpServerSession(entry, dir, dir, { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] },
    new CatalogCache(dir), () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {});
  t.after(() => owner.shutdown());
  fixture.state.onList = async () => { fixture.state.onList = undefined; await command("logout", "fixture"); };
  await assert.rejects(owner.discover(), /authorization or environment changed/);
  assert.deepEqual(owner.catalog.tools, [], "account-specific directory must not survive a logout during discovery");
  assert.equal(await owner.restore(), false, "the old directory was not cached under the logged-out identity");
});
