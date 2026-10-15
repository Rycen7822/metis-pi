import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { McpServerSession } from "../../src/mcp/session.ts";
import { readMcpConfiguration } from "../../src/mcp/config.ts";
import { CatalogCache } from "../../src/mcp/catalog.ts";
import { McpCredentials, createAuth } from "../../src/mcp/auth.ts";
import { convertResult, syncTools } from "../../src/mcp/tools.ts";
import { startHttp, image } from "../helpers/mcp-server.mjs";
const run = promisify(execFile), cli = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));

test("MCP policy is global-only while Pi trusted project server definitions still work", t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-mcp-config-")), cwd = join(dir, "project");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(dir, "metis-pi.toml"), '[mcp]\nenabled=true\nidleTimeoutSeconds=123\nkeepAliveServers=["global"]\n');
  writeFileSync(join(cwd, ".pi", "metis-pi.toml"), '[mcp]\nenabled=false\nidleTimeoutSeconds=1\n');
  writeFileSync(join(cwd, ".pi", "metis-pi.json"), '{"mcp":{"idleTimeoutSeconds":2}}');
  writeFileSync(join(cwd, ".pi", "mcp.json"), '{"mcpServers":{"project":{"url":"http://localhost:1234/mcp"}}}');
  for (const trusted of [false, true]) {
    const result = readMcpConfiguration(dir, cwd, trusted);
    assert.deepEqual(result.policy, { enabled: true, idleTimeoutSeconds: 123, keepAliveServers: ["global"] });
    assert.equal(result.servers.length, trusted ? 1 : 0);
    assert.deepEqual(result.errors, []);
  }
});

test("HTTP preserves result/images, filters Apps, retries only expired sessions and observes live catalog changes", async (t) => {
  const fixture = await startHttp(),
    dir = mkdtempSync(join(tmpdir(), "metis-mcp-http-"));
  const owner = new McpServerSession(
    { name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } },
    dir,
    dir,
    { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] },
    new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }),
    () => {},
  );
  t.after(async () => {
    await owner.shutdown();
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await owner.discover();
  const result = await convertResult(
    "fixture",
    "echo",
    await owner.callTool(owner.catalog.tools[0], owner.scope, { value: 1, domainError: true }, {}),
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.structuredContent.value, 1);
  assert.equal(result.content.find((block) => block.type === "image").data, image);
  assert.doesNotMatch(JSON.stringify(result), /UI_SECRET|ui:\/\/panel/);
  fixture.state.expire = true;
  const before = fixture.state.calls;
  await owner.callTool(owner.catalog.tools[0], owner.scope, { value: 2 }, {});
  assert.equal(fixture.state.calls, before + 1);
  assert.equal(fixture.state.starts, 2);
  fixture.state.fail = true;
  await assert.rejects(owner.callTool(owner.catalog.tools[0], owner.scope, { value: 3 }, {}));
  assert.equal(fixture.state.calls, before + 2, "failure after execution must not replay the call");
  fixture.state.fail = false;
  fixture.state.type = "string";
  fixture.notify();
  const deadline = Date.now() + 2000;
  while (owner.catalog.tools[0].inputSchema.properties.value.type !== "string" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(owner.catalog.tools[0].inputSchema.properties.value.type, "string");
});

test("tools register before failing resources, with resources and MIME filtering used only on demand", async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-resources-"));
  fixture.state.failResources = true;
  const owner = new McpServerSession(
    { name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } }, dir, dir,
    { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {},
  );
  t.after(async () => { await owner.shutdown(); await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  await owner.discover();
  assert.equal(owner.state, "connected");
  assert.equal(fixture.state.clientInfo.version, "1.3.0");
  assert.deepEqual(owner.catalog.tools.map(tool => tool.name), ["echo"]);
  assert.equal(owner.catalog.hasResources, true);
  assert.deepEqual(owner.catalog.resources, []);
  assert.deepEqual(owner.catalog.resourceTemplates, []);
  assert.ok(!fixture.state.methods.some(method => method.startsWith("resources/")));
  const registered = new Map(), owned = new Map();
  syncTools({ getAllTools: () => [...registered.values()], getActiveTools: () => [], setActiveTools() {},
    registerTool: tool => registered.set(tool.name, tool) }, [owner], owned);
  const gateways = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  for (const name of gateways) assert.equal(registered.get(name).exposure, "deferred");
  const call = (name, args) => registered.get(name).execute(`resource-${name}`, args);
  await assert.rejects(call("list_mcp_resources", { server: "fixture" }));
  await assert.rejects(call("list_mcp_resource_templates", { server: "fixture" }));
  assert.equal(owner.state, "connected", "resource failure does not retire the tool connection");
  fixture.state.failResources = false;
  const listed = (await call("list_mcp_resources", { server: "fixture" })).structuredContent;
  assert.deepEqual(listed.resources.map(resource => resource.uri), ["data://plain"]);
  const templates = (await call("list_mcp_resource_templates", { server: "fixture" })).structuredContent;
  assert.deepEqual(templates.resourceTemplates.map(resource => resource.uriTemplate), ["data://{name}"]);
  const ui = await call("read_mcp_resource", { server: "fixture", uri: "data://panel" });
  assert.deepEqual(ui.structuredContent.contents, [], "opaque App URI is filtered by the read result MIME");
  assert.doesNotMatch(JSON.stringify(ui), /UI_SECRET/);
  await assert.rejects(call("read_mcp_resource", { server: "fixture", uri: "ui://panel" }), /App UI/);
  const preparedReader = registered.get("read_mcp_resource"), reads = fixture.state.methods.filter(method => method === "resources/read").length;
  owner.entry.config.exposure = "hidden";
  syncTools({ getAllTools: () => [...registered.values()], getActiveTools: () => [], setActiveTools() {},
    registerTool: tool => registered.set(tool.name, tool) }, [owner], owned);
  for (const name of gateways) assert.equal(registered.get(name).exposure, "hidden");
  await assert.rejects(preparedReader.execute("hidden-read", { server: "fixture", uri: "data://plain" }), /not available/);
  assert.equal(fixture.state.methods.filter(method => method === "resources/read").length, reads,
    "a previously prepared resource gateway cannot dispatch after its server is hidden");
});

test("real MCP client and codemode result wrapper retain every JSON structured value", async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-json-"));
  fixture.state.outputSchema = undefined;
  fixture.state.omitContent = true;
  const owner = new McpServerSession(
    { name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } }, dir, dir,
    { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {},
  );
  t.after(async () => { await owner.shutdown(); await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  await owner.discover();
  const registered = new Map();
  syncTools({ getAllTools: () => [...registered.values()], getActiveTools: () => [], setActiveTools() {},
    registerTool: tool => registered.set(tool.name, tool) }, [owner], new Map());
  const definition = registered.get("mcp__fixture__echo");
  assert.deepEqual(definition.outputSchema.properties.structuredContent, {});
  for (const value of [{ nested: { value: 1 } }, [1, null, "array"], null, false, 0, "primitive"]) {
    fixture.state.structuredContent = value;
    const result = await definition.execute("json-value", { value: 1 });
    assert.deepEqual(result.structuredContent.structuredContent, value);
    assert.deepEqual(result.structuredContent.content, []);
    assert.deepEqual(JSON.parse(result.content[0].text), value);
  }
});

test("nested MCP output schemas relocate local refs without changing literal data or named properties", async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-schema-"));
  const literal = { $ref: "#/$defs/literal-data" };
  fixture.state.outputSchema = { type: "object", $defs: { Value: { type: "string" } },
    properties: { value: { $ref: "#/$defs/Value" }, self: { $ref: "#" }, remote: { $ref: "https://example.invalid/schema" },
      $ref: { $ref: "#/$defs/Value" }, literal: { const: literal, default: literal, examples: [literal] } } };
  const owner = new McpServerSession(
    { name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } }, dir, dir,
    { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {},
  );
  t.after(async () => { await owner.shutdown(); await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  await owner.discover();
  const registered = new Map();
  syncTools({ getAllTools: () => [...registered.values()], getActiveTools: () => [], setActiveTools() {},
    registerTool: tool => registered.set(tool.name, tool) }, [owner], new Map());
  const output = registered.get("mcp__fixture__echo").outputSchema.properties.structuredContent;
  assert.equal(output.properties.value.$ref, "#/properties/structuredContent/$defs/Value");
  assert.equal(output.properties.self.$ref, "#/properties/structuredContent");
  assert.equal(output.properties.$ref.$ref, "#/properties/structuredContent/$defs/Value");
  assert.equal(output.properties.remote.$ref, "https://example.invalid/schema");
  assert.deepEqual(output.properties.literal, { const: literal, default: literal, examples: [literal] });
  assert.deepEqual(owner.catalog.tools[0].outputSchema, fixture.state.outputSchema, "registration does not mutate the server catalog");
});

test(
  "native CLI and Metis share OAuth rotation locks, while logout wins over a late refresh",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await startHttp({ oauth: true }),
      dir = mkdtempSync(join(tmpdir(), "metis-mcp-oauth-"));
    t.after(async () => {
      await fixture.close();
      rmSync(dir, { recursive: true, force: true });
    });
    mkdirSync(join(dir, "bin"));
    const browser = "#!/usr/bin/env node\nfetch(process.argv[2]).catch(() => process.exit(1));\n";
    for (const name of ["xdg-open", "open"]) writeFileSync(join(dir, "bin", name), browser, { mode: 0o700 });
    const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PATH: join(dir, "bin") + delimiter + process.env.PATH };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: fixture.url } } }));
    const command = (...args) => run(process.execPath, [cli, "mcp", ...args], { cwd: dir, env, timeout: 15000 });
    const loggedIn = await command("login", "fixture", "--timeout", "8");
    assert.match(loggedIn.stdout, /Signed in/);
    const entry = { name: "fixture", config: { url: fixture.url }, source: "fixture", scope: "global" };
    const store = new McpCredentials(dir, entry),
      auth = createAuth(entry, store),
      path = join(dir, "mcp-auth.json");
    const expire = () => {
      const state = JSON.parse(readFileSync(path, "utf8"));
      state[store.key].tokensExpireAt = 0;
      writeFileSync(path, JSON.stringify(state));
    };
    expire();
    fixture.state.refreshDelay = 1000;
    let begun;
    const started = new Promise((resolve) => {
      begun = resolve;
    });
    fixture.state.onRefresh = begun;
    const token = auth.token();
    await started;
    const listed = command("list");
    const [value, listing] = await Promise.all([token, listed]);
    assert.equal(value, "access-2");
    assert.match(listing.stdout, /fixture/);
    assert.equal(fixture.state.refreshes, 1);
    assert.equal((await store.load()).tokens.refresh_token, "refresh-2");
    expire();
    fixture.state.refreshDelay = 1500;
    let next;
    const refreshing = new Promise((resolve) => {
      next = resolve;
    });
    fixture.state.onRefresh = next;
    const pending = auth.token();
    await refreshing;
    await command("logout", "fixture");
    await pending;
    assert.equal(await store.load(), undefined, "late refresh must not recreate logged-out credentials");
    await command("login", "fixture", "--timeout", "8");
    const owner = new McpServerSession(
      entry,
      dir,
      dir,
      { enabled: true, idleTimeoutSeconds: 600, keepAliveServers: [] },
      new CatalogCache(dir),
      () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }),
      () => {},
    );
    t.after(() => owner.shutdown());
    fixture.state.onList = async () => {
      fixture.state.onList = undefined;
      await command("logout", "fixture");
    };
    await assert.rejects(owner.discover(), /authorization or environment changed/);
    assert.deepEqual(owner.catalog.tools, [], "account-specific directory must not survive a logout during discovery");
    assert.equal(await owner.restore(), false, "the old directory was not cached under the logged-out identity");
  },
);
