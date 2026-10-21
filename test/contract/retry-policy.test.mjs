import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installGatewayRetry } from "../../src/retry-policy.ts";
import { disableNetwork } from "../helpers/native-provider.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CODE = "workspace_billing_scope_unavailable";
const GATEWAY_503 = `503: ${JSON.stringify({ code: CODE, type: CODE,
  message: `[code=${CODE}] resolve Billing Scope: Get "https://amr-api.open-design.ai/api/internal/billing/scope/test-workspace": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
})}`;
const QUOTA_429 = "429 insufficient_quota: You exceeded your current quota";
const packages = enabled => enabled ? [{ source: root, extensions: ["extensions/retry-policy.ts"] }] : [];
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
test.beforeEach(disableNetwork);

async function host(t, { errorMessage = GATEWAY_503, enabled = true,
  retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 } } = {}) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work", "retry-host-"));
  const agentDir = join(dir, "agent"), cwd = join(dir, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  let session;
  const errors = [];
  t.after(async () => {
    try { await session?.extensionRunner.emit({ type: "session_shutdown" }); } finally {
      session?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(errors, []);
  });
  const settingsManager = SettingsManager.inMemory({ packages: packages(enabled), compaction: { enabled: false }, retry });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false,
  });
  const model = {
    id: "retry-test", name: "Retry test", provider: "retry-test", api: "openai-completions",
    baseUrl: "http://invalid", reasoning: false, input: ["text"], contextWindow: 100_000,
    maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await modelRuntime.setRuntimeApiKey(model.provider, "offline");
  let calls = 0, remaining = 0;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, eventBus: createEventBus(),
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "RETRY_TEST",
  });
  await loader.reload();
  const loaded = await createAgentSession({
    cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), model,
  });
  session = loaded.session;
  assert.deepEqual(loaded.extensionsResult.errors, []);
  await session.bindExtensions({ onError: error => errors.push(error) });
  // Register after reload too: Pi rebuilds the provider catalog on reload.
  const register = () => modelRuntime.registerProvider(model.provider, {
    api: model.api, apiKey: "offline", models: [model],
    streamSimple(m) {
      calls++;
      const output = createAssistantMessageEventStream();
      const message = {
        role: "assistant", api: m.api, provider: m.provider, model: m.id,
        timestamp: Date.now(), usage, content: [], stopReason: "stop",
      };
      if (remaining-- > 0) {
        Object.assign(message, { stopReason: "error", errorMessage });
        output.push({ type: "error", reason: "error", error: message });
      } else {
        message.content = [{ type: "text", text: "RECOVERED" }];
        output.push({ type: "done", reason: "stop", message });
      }
      output.end(message);
      return output;
    },
  });
  register();
  return {
    session,
    async reload(enabled) {
      settingsManager.setPackages(packages(enabled));
      await session.reload();
      register();
    },
    async run(failures = 1) {
      const before = calls;
      remaining = failures;
      await session.prompt("RETRY_SENTINEL");
      await session.waitForIdle();
      return { calls: calls - before, final: session.agent.state.messages.findLast(message => message.role === "assistant") };
    },
  };
}

test("gateway lookup failure is retried and the turn recovers", { timeout: 20_000 }, async t => {
  const h = await host(t);
  const result = await h.run();
  assert.equal(result.calls, 2);
  assert.equal(result.final.stopReason, "stop");
  assert.deepEqual(result.final.content, [{ type: "text", text: "RECOVERED" }]);
  const failure = h.session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.stopReason === "error");
  assert.equal(failure.message.errorMessage, GATEWAY_503, "persist the original error, not the classification copy");
});

for (const errorMessage of [QUOTA_429, `503: ${CODE}: insufficient_quota`, `400 context_length_exceeded: ${CODE}`])
  test(`native rejection stays authoritative: ${errorMessage}`, { timeout: 20_000 }, async t => {
    const result = await (await host(t, { errorMessage })).run();
    assert.equal(result.calls, 1);
    assert.equal(result.final.stopReason, "error");
    assert.equal(result.final.errorMessage, errorMessage);
  });

test("retry.enabled=false keeps the native single attempt", { timeout: 20_000 }, async t => {
  const result = await (await host(t, { retry: { enabled: false } })).run();
  assert.equal(result.calls, 1);
  assert.equal(result.final.stopReason, "error");
});

test("gateway retries respect exhaustion and preserve the final error", { timeout: 20_000 }, async t => {
  const result = await (await host(t, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } })).run(Infinity);
  assert.equal(result.calls, 2);
  assert.equal(result.final.errorMessage, GATEWAY_503);
});

test("abort during native retry backoff prevents another provider attempt", { timeout: 20_000 }, async t => {
  const h = await host(t, { retry: { enabled: true, maxRetries: 3, baseDelayMs: 30_000 } });
  const scheduled = Promise.withResolvers();
  h.session.subscribe(event => { if (event.type === "auto_retry_start") scheduled.resolve(); });
  const running = h.run(Infinity);
  await scheduled.promise;
  await h.session.abort();
  assert.equal((await running).calls, 1);
});

test("reload disables and re-enables gateway retry without a process restart", { timeout: 20_000 }, async t => {
  const h = await host(t);
  for (const enabled of [true, false, true]) {
    await h.reload(enabled);
    assert.equal((await h.run()).calls, enabled ? 2 : 1);
  }
});

test("an enabled session does not change a neighbour without the extension", { timeout: 20_000 }, async t => {
  const enabled = await host(t);
  const native = await host(t, { enabled: false });
  assert.equal((await native.run()).calls, 1);
  assert.equal((await enabled.run()).calls, 2);
});

test("hook leases preserve native decisions, other owners and descriptor restrictions", () => {
  class Host {
    sessionManager = {};
    _isRetryableError(message) { return !isContextOverflow(message) && isRetryableAssistantError(message); }
  }
  const original = Object.getOwnPropertyDescriptor(Host.prototype, "_isRetryableError");
  const a = new Host(), b = new Host();
  const releaseA = installGatewayRetry(Host, a.sessionManager);
  const releaseB = installGatewayRetry(Host, b.sessionManager);
  const releaseAgain = installGatewayRetry(Host, a.sessionManager);
  const error = { stopReason: "error", errorMessage: GATEWAY_503 };
  assert.equal(a._isRetryableError(error), true);
  releaseAgain(); releaseAgain();
  assert.equal(a._isRetryableError(error), true, "releasing one lease must not detach the other");
  releaseA();
  assert.equal(a._isRetryableError(error), false);
  assert.equal(b._isRetryableError(error), true);
  assert.equal(b._isRetryableError({ stopReason: "stop", errorMessage: GATEWAY_503 }), false);
  assert.equal(b._isRetryableError({ stopReason: "error", errorMessage: "503 service unavailable" }), true);
  assert.equal(b._isRetryableError({ stopReason: "error", errorMessage: `${CODE}_permanent` }), false);
  releaseB();
  assert.deepEqual(Object.getOwnPropertyDescriptor(Host.prototype, "_isRetryableError"), original);

  const release = installGatewayRetry(Host, a.sessionManager);
  const wrapped = Host.prototype._isRetryableError;
  Object.defineProperty(Host.prototype, "_isRetryableError", { ...original, writable: false });
  release();
  assert.equal(Host.prototype._isRetryableError, original.value, "do not overwrite a later owner");
  assert.equal(Object.getOwnPropertyDescriptor(Host.prototype, "_isRetryableError").writable, false);
  assert.equal(wrapped.call(a, error), false, "even a retained wrapper must become inert after release");
});

test("an unavailable or non-extensible host is left untouched", () => {
  assert.throws(() => installGatewayRetry(class {}, {}), /unavailable/);
  class Host { _isRetryableError() { return false; } }
  const original = Object.getOwnPropertyDescriptors(Host.prototype);
  Object.preventExtensions(Host.prototype);
  assert.throws(() => installGatewayRetry(Host, {}), /unavailable/);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), original);
});
