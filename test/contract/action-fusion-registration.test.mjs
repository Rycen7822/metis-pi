import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { disableNetwork } from "../helpers/native-provider.mjs";

test.beforeEach(disableNetwork);
const fusionEntry = fileURLToPath(new URL("../../extensions/action-fusion.ts", import.meta.url));
const vendorEntry = fileURLToPath(new URL("../../extensions/execution.ts", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function fusionWorkspace(t, prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const errors = [];
  let session;
  t.after(async () => {
    try {
      try { await session?.extensionRunner.emit({ type: "session_shutdown" }); }
      finally { session?.dispose(); }
      assert.deepEqual(errors, []);
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  async function start({ settingsManager, sessionManager, additionalExtensionPaths }) {
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, additionalExtensionPaths,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"), modelsPath: null,
      modelsStorePath: join(cwd, "models.json"), refreshOnCreate: false,
    });
    await resourceLoader.reload();
    const loaded = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader, sessionManager });
    session = loaded.session;
    assert.deepEqual(loaded.extensionsResult.errors, []);
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    return session;
  }

  return { cwd, start };
}

for (const reverseOrder of [false, true])
  test(`fusion entry controls native schemas with reverse load order=${reverseOrder}`, async (t) => {
    const { cwd, start } = fusionWorkspace(t, "metis-fusion-switch-");
    const packages = (disabled) => [
      {
        source: packageRoot,
        extensions: [
          "extensions/action-fusion.ts",
          "extensions/execution.ts",
          ...(disabled ? ["-extensions/action-fusion.ts"] : []),
        ],
      },
    ];
    const settingsManager = SettingsManager.inMemory({ packages: reverseOrder ? [] : packages(false) });
    const session = await start({
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      additionalExtensionPaths: reverseOrder ? [vendorEntry, fusionEntry] : [],
    });
    for (const disabled of reverseOrder ? [false] : [false, true, false]) {
      if (!reverseOrder) {
        settingsManager.setPackages(packages(disabled));
        await session.reload();
      }
      const tools = session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition);
      assert.ok(
        tools.find((tool) => tool.name === "exec_command"),
        "terminal remains available when fusion is disabled",
      );
      for (const name of ["edit", "write"])
        assert.equal(Boolean(tools.find((tool) => tool.name === name)?.parameters.properties.then_run), !disabled);
    }
  });

for (const foreignWrite of [false, true])
  test(`real host registers native fusion and respects foreign write=${foreignWrite}`, async (t) => {
    const { cwd, start } = fusionWorkspace(t, "metis-fusion-entry-");
    const extra = join(cwd, "foreign.ts");
    if (foreignWrite)
      writeFileSync(
        extra,
        'export default function(pi){pi.registerTool({name:"write",label:"foreign",descri' +
          'ption:"foreign",parameters:{type:"object",properties:{}},async ' +
          'execute(){return{content:[{type:"text",text:"foreign"}],details:{}}}})}',
      );
    const session = await start({
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.create(cwd, cwd),
      additionalExtensionPaths: [fusionEntry, ...(foreignWrite ? [extra] : [])],
    });
    const tools = session.extensionRunner.getAllRegisteredTools();
    const write = tools.find((tool) => tool.definition.name === "write");
    const edit = tools.find((tool) => tool.definition.name === "edit");
    assert.ok(edit.definition.parameters.properties.then_run);
    assert.equal(write.definition.label === "foreign", foreignWrite);
    if (foreignWrite) {
      assert.equal(write.definition.parameters.properties.then_run, undefined);
      return;
    }
    assert.equal(write.sourceInfo.path, fusionEntry);
    assert.ok(write.definition.parameters.properties.then_run);
    const ctx = { cwd, isProjectTrusted: () => false, sessionManager: session.sessionManager };
    const result = await write.definition.execute(
      "native-fused",
      { path: "file", content: "saved", then_run: { command: "exit 3" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(readFileSync(join(cwd, "file"), "utf8"), "saved");
    const changed = await session.extensionRunner.emitToolResult({
      type: "tool_result",
      toolName: "write",
      toolCallId: "native-fused",
      input: {},
      content: result.content,
      details: result.details,
      isError: false,
    });
    assert.equal(changed.isError, true);
    assert.equal(result.details.metisActionFusion.mutationStatus, "success");
    assert.equal(result.details.metisActionFusion.command.exitCode, 3);
    assert.match(
      result.content.map((block) => block.text ?? "").join("\n"),
      /Exit code: 3/,
      "Pi codemode rejects failed built-ins with their text, so the actual exit code must survive there",
    );
    const normalizedTarget = join(cwd, "fusion path");
    writeFileSync(normalizedTarget, "before");
    const normalized = await write.definition.execute(
      "normalized",
      { path: "@fusion\u00a0path", content: "after" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(readFileSync(normalizedTarget, "utf8"), "after");
    assert.equal(normalized.details.metisWriteDiff.kind, "update");
    await session.extensionRunner.emit({ type: "session_start" });
    assert.equal(
      session.extensionRunner.getAllRegisteredTools().filter((tool) => tool.definition.name === "write").length,
      1,
    );
    const pending = write.definition.execute(
      "shutdown-fused",
      { path: "other", content: "saved before shutdown", then_run: { command: "printf started > started; sleep 20" } },
      undefined,
      undefined,
      ctx,
    );
    const deadline = Date.now() + 5000;
    while (!existsSync(join(cwd, "started")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(join(cwd, "started")), "shutdown proof requires a running child");
    await session.extensionRunner.emit({ type: "session_shutdown" });
    const cancelled = await pending;
    assert.equal(cancelled.details.metisActionFusion.command.status, "cancelled");
    assert.equal(readFileSync(join(cwd, "other"), "utf8"), "saved before shutdown");
  });
