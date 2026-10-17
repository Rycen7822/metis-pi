import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { disableNetwork } from "../helpers/native-provider.mjs";

test.beforeEach(disableNetwork);
const root = fileURLToPath(new URL("../../", import.meta.url));
const webTools = ["web_access"];
const recallTools = ["session_recall"];

async function loadManaged(t, disabled = [], webAccess, bindRuntime = false, includeLsp = false) {
  const dir = mkdtempSync(join(tmpdir(), "metis-managed-plugins-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (webAccess) writeFileSync(join(dir, "metis-pi.toml"), stringify({ webAccess }));
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({
      packages: [{
        source: root,
        extensions: ["extensions/web-access.ts", "extensions/session-recall.ts", ...(includeLsp ? ["extensions/lsp.ts"] : []), ...disabled],
      }],
    }),
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  if (bindRuntime) {
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
      model: getBuiltinModels("openai")[0], sessionManager: SessionManager.inMemory(dir),
    });
    await session.bindExtensions({});
    t.after(() => session.dispose());
  }
  return loaded.extensions;
}

test("Metis package discovers its web and recall tools through owned entrypoints", async (t) => {
  const extensions = await loadManaged(t);
  assert.deepEqual(extensions.map((extension) => extension.path).sort(), [
    join(root, "extensions/session-recall.ts"), join(root, "extensions/web-access.ts"),
  ]);
  const tools = extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.deepEqual(tools.sort(), [...webTools, ...recallTools].sort());
  for (const extension of extensions) for (const tool of extension.tools.values()) {
    assert.equal(tool.definition.exposure, "deferred");
  }
});

test("Metis discovers its direct LSP entry alongside deferred web/recall and can filter it independently", async t => {
  const extensions = await loadManaged(t, [], undefined, true, true);
  const tools = extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["lsp", ...webTools, ...recallTools].sort());
  const lsp = tools.find(tool => tool.name === "lsp");
  assert.ok(lsp.exposure === undefined || lsp.exposure === "direct");
  assert.deepEqual(lsp.parameters.properties.action.enum, ["diagnostics", "fix"]);
  assert.ok(extensions.find(extension => extension.tools.has("lsp")).commands.has("lsp"));
  const filtered = await loadManaged(t, ["-extensions/lsp.ts"], undefined, false, true);
  assert.deepEqual(filtered.flatMap(extension => [...extension.tools.keys()]).sort(), [...webTools, ...recallTools].sort());
});

test("Pi package filters disable web access while retaining session recall", async (t) => {
  const extensions = await loadManaged(t, ["-extensions/web-access.ts"]);
  assert.deepEqual(extensions.map((extension) => extension.path), [join(root, "extensions/session-recall.ts")]);
  assert.deepEqual([...extensions[0].tools.keys()].sort(), recallTools.slice().sort());
});

test("owned web entrypoint registers tools from the existing Metis TOML", async (t) => {
  const extensions = await loadManaged(t, [], {
    toolActivation: "eager", toolNames: { webSearch: "lookup_web" }, tools: { sourceCheck: { enabled: false } },
    ssrf: { allowRanges: ["127.0.0.1"] },
  }, true);
  assert.deepEqual(extensions.flatMap(extension => [...extension.tools.keys()]).sort(), [
    ...webTools, ...recallTools,
  ].sort());
  const web = extensions.find(extension => extension.tools.has("web_access")).tools.get("web_access").definition;
  assert.deepEqual(web.parameters.properties.action.enum, ["describe", "search", "fetch", "content"]);
  assert.doesNotMatch(web.description, /check sources/);
  const result = await web.execute("describe", { action: "describe", target: "fetch" });
  assert.deepEqual(result.structuredContent.parameters.properties.mode.enum, ["readable", "raw", "answer"]);
  assert.match(result.structuredContent.description, /web_access action=content/);
  await assert.rejects(web.execute("invalid", { action: "content", params: {} }), /responseId/);
  const error = web.renderResult({ content: [{ type: "text", text: "Missing responseId" }], details: {} },
    { expanded: false, isPartial: false }, { fg: (_style, text) => text }, { isError: true });
  assert.match(error.render(80).join("\n"), /Missing responseId/);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Local fixture material. ".repeat(1600));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/grouped-fixture`;
  const fetched = await web.execute("fetch", { action: "fetch", params: { url, mode: "raw" } });
  assert.deepEqual(requests, [{ method: "GET", path: "/grouped-fixture" }]);
  assert.notEqual(fetched.isError, true);
  const text = fetched.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /tools\.web_access\(\{ action: "content", params:/);
  assert.doesNotMatch(text, /get_search_content\(/);
});

test("session_recall query reads its model from global TOML at each call", async (t) => {
  const extensions = await loadManaged(t, ["-extensions/web-access.ts"]);
  const query = extensions[0].tools.get("session_recall").definition;
  const dir = process.env.PI_CODING_AGENT_DIR, configPath = join(dir, "metis-pi.toml");
  const current = { provider: "openai", id: "current", contextWindow: 32768 };
  const dedicated = { ...current, id: "recall/variant" }, codex = { ...dedicated, provider: "openai-codex" };
  const manager = SessionManager.inMemory(dir), sessionPath = join(dir, "query.jsonl");
  manager.appendMessage({ role: "user", content: "What changed?", timestamp: 0 });
  writeFileSync(sessionPath, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"));
  let selected;
  const ctx = {
    model: current,
    modelRegistry: {
      find: (provider, id) => [dedicated, codex].find(model => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: () => { assert.fail("Recall must let the host runtime resolve request-time auth"); },
      streamSimple: (model) => {
        selected = model;
        return { result: async () => ({ stopReason: "error", errorMessage: "Model selection captured without a provider request", content: [] }) };
      },
    },
  };
  await assert.rejects(query.execute("invalid-query", {
    action: "query", params: { sessionPath },
  }, undefined, undefined, ctx), /question/);
  for (const [selection, expected] of [
    ["openai/recall/variant", dedicated], ["openai-codex/recall/variant", codex],
    ["default", current], [undefined, current], ["openai/missing", current], ["invalid", current], [123, current],
  ]) {
    writeFileSync(configPath, selection === undefined ? "" : stringify({ sessionRecall: { queryModel: selection } }));
    selected = undefined;
    await query.execute("query-model", {
      action: "query", params: { sessionPath, question: "What changed?" },
    }, undefined, undefined, ctx);
    assert.equal(selected, expected);
  }
  writeFileSync(configPath, "[broken");
  selected = undefined;
  const result = await query.execute("broken-config", {
    action: "query", params: { sessionPath, question: "What changed?" },
  }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /invalid TOML/);
  assert.equal(selected, undefined);
});
