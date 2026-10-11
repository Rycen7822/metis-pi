import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { DefaultResourceLoader, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { disableNetwork } from "../helpers/native-provider.mjs";

test.beforeEach(disableNetwork);
const root = fileURLToPath(new URL("../../", import.meta.url));
const webTools = ["web_search", "source_check", "fetch_content", "get_search_content", "web_enable"];
const recallTools = ["session_search", "session_query"];

async function loadManaged(t, disabled = []) {
  const dir = mkdtempSync(join(tmpdir(), "metis-managed-plugins-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
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
        extensions: ["extensions/web-access.ts", "extensions/session-recall.ts", ...disabled],
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
  return loaded.extensions;
}

test("Metis package discovers its web and recall tools through owned entrypoints", async (t) => {
  const extensions = await loadManaged(t);
  assert.deepEqual(extensions.map((extension) => extension.path).sort(), [
    join(root, "extensions/session-recall.ts"), join(root, "extensions/web-access.ts"),
  ]);
  const tools = extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.deepEqual(tools.sort(), [...webTools, ...recallTools].sort());
});

test("Pi package filters disable web access while retaining session recall", async (t) => {
  const extensions = await loadManaged(t, ["-extensions/web-access.ts"]);
  assert.deepEqual(extensions.map((extension) => extension.path), [join(root, "extensions/session-recall.ts")]);
  assert.deepEqual([...extensions[0].tools.keys()].sort(), recallTools.slice().sort());
});

test("session_query reads its model from global TOML at each call", async (t) => {
  const extensions = await loadManaged(t, ["-extensions/web-access.ts"]);
  const query = extensions[0].tools.get("session_query").definition;
  const dir = process.env.PI_CODING_AGENT_DIR, configPath = join(dir, "metis-pi.toml");
  const current = { provider: "openai", id: "current", contextWindow: 32768 };
  const dedicated = { ...current, id: "recall/variant" }, codex = { ...dedicated, provider: "openai-codex" };
  writeFileSync(join(dir, "session-recall.json"), JSON.stringify({
    queryModel: { provider: dedicated.provider, id: dedicated.id },
  }));
  const manager = SessionManager.inMemory(dir), sessionPath = join(dir, "query.jsonl");
  manager.appendMessage({ role: "user", content: "What changed?", timestamp: 0 });
  writeFileSync(sessionPath, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"));
  let selected;
  const ctx = {
    model: current,
    modelRegistry: {
      find: (provider, id) => [dedicated, codex].find(model => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async (model) => {
        selected = model;
        return { ok: false, error: "Model selection captured without a provider request" };
      },
    },
  };
  for (const [selection, expected] of [
    ["openai/recall/variant", dedicated], ["openai-codex/recall/variant", codex],
    ["default", current], [undefined, current], ["openai/missing", current], ["invalid", current], [123, current],
  ]) {
    writeFileSync(configPath, selection === undefined ? "" : stringify({ sessionRecall: { queryModel: selection } }));
    selected = undefined;
    await query.execute("query-model", { sessionPath, question: "What changed?" }, undefined, undefined, ctx);
    assert.equal(selected, expected);
  }
  writeFileSync(configPath, "[broken");
  selected = undefined;
  const result = await query.execute("broken-config", { sessionPath, question: "What changed?" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /invalid TOML/);
  assert.equal(selected, undefined);
});
