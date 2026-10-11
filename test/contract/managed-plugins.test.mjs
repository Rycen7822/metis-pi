import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
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
