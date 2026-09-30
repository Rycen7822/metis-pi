import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { FAKE_API_KEY, captureRegistration, disableNetwork, modelNamed } from "../helpers/vendor-codex-provider.mjs";

test.beforeEach(disableNetwork);

const ENTRY = fileURLToPath(new URL("../../src/codex/extension.ts", import.meta.url));
test("built vendor entry follows Pi's catalog and wires lifecycle, final requests and shipped tool schemas", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "metis-vendor-entry-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  let session;
  const errors = [];
  t.after(async () => {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown" });
      assert.deepEqual(errors, [], "the real host must report no extension lifecycle errors");
    } finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"), modelsPath: null,
    modelsStorePath: join(cwd, "models-cache.json"), refreshOnCreate: false,
  });
  const builtinModels = modelRuntime.getModels("openai-codex");
  let catalogProvider;
  const register = modelRuntime.registerNativeProvider.bind(modelRuntime);
  const nativeRegistration = t.mock.method(modelRuntime, "registerNativeProvider", (provider) => {
    if (provider.id === "openai-codex") catalogProvider = modelRuntime.getProvider(provider.id);
    return register(provider);
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, additionalExtensionPaths: [ENTRY],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "ENTRY_PROMPT",
  });
  await resourceLoader.reload();
  const loaded = await createAgentSession({
    cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  session = loaded.session;
  assert.deepEqual(loaded.extensionsResult.errors, []);
  assert.equal(loaded.extensionsResult.extensions.length, 1);
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  assert.deepEqual(errors, []);
  const provider = modelRuntime.getRegisteredNativeProvider("openai-codex");
  const tools = session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition);
  assert.ok(provider, "entry session_start installs the native provider");
  const registrations = () => nativeRegistration.mock.calls.filter(({ arguments: [value] }) => value.id === "openai-codex").length;
  assert.equal(registrations(), 1);
  await session.extensionRunner.emit({ type: "session_start" });
  assert.equal(registrations(), 1, "another session_start must reuse the provider");
  const hostModels = catalogProvider.getModels();
  assert.deepEqual(hostModels, builtinModels, "the initial overlay must inherit the complete Pi catalog");
  const additions = ["gpt-6-sol", "gpt-6-luna", "future-codex-model"].map((id) => ({
    ...modelNamed("gpt-6-astra"), id, thinkingLevelMap: { off: "none", low: "low", high: "high" },
  }));
  t.mock.method(catalogProvider, "getModels", () => [...hostModels, ...additions]);
  assert.ok(provider.getModels().some(({ id }) => id === "future-codex-model"), "catalog updates remain visible through the real host overlay");
  for (const original of additions) {
    const actual = provider.getModels().find(({ id }) => id === original.id);
    assert.deepEqual(actual, { ...original, thinkingLevelMap: { ...original.thinkingLevelMap,
      off: original.id === "future-codex-model" ? "none" : null } });
    assert.equal(original.thinkingLevelMap.off, "none", "host-owned model metadata remains untouched");
  }
  assert.equal(provider.refreshModels, catalogProvider.refreshModels, "catalog refresh delegates to the host");
  assert.equal(provider.auth, catalogProvider.auth, "login and credential refresh delegate to the host");
  assert.ok(provider.getModels().some(({ id }) => id === "gpt-reserve"));
  assert.ok(!provider.filterModels(provider.getModels(), {}).some(({ id }) => id === "gpt-reserve"));
  const capture = await captureRegistration(provider);
  await capture.registration.streamSimple(modelNamed("gpt-6-astra"), {
    systemPrompt: "ENTRY_PROMPT", tools: [], messages: [{ role: "user", content: "ENTRY_INPUT", timestamp: 0 }],
  }, { apiKey: FAKE_API_KEY }).result();
  assert.equal(capture.calls, 1);
  assert.equal(capture.bodies[0].instructions, "ENTRY_PROMPT");
  assert.match(JSON.stringify(capture.bodies[0].input), /ENTRY_INPUT/);
  const names = tools.map(({ name }) => name);
  for (const name of ["exec", "wait", "apply_patch", "view_image"]) {
    assert.ok(names.includes(name), `missing shipped tool ${name}`);
  }
  for (const { name, parameters } of tools) {
    const wire = JSON.parse(JSON.stringify(parameters ?? {}));
    assert.equal(wire.type, "object", `${name}: top-level schema must be an object`);
    assert.equal(wire.anyOf, undefined, `${name}: top-level union is unsupported`);
  }
});
