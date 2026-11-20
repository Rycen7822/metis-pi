import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { createAgentSessionServices, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

const openai = "https://api.openai.com/v1/models";
const legacy = "https://chatgpt.com/backend-api/codex/models?client_version=0.150.0";
const visibleSol = { slug: "gpt-6.2-sol", display_name: "Account catalog Sol", visibility: "list", context_window: 500_000,
  max_context_window: 872_000, input_modalities: ["text", "image", "audio"],
  supported_reasoning_levels: ["low", "high", "max", "ultra"].map(effort => ({ effort })) };
const oauth = (access: string) => ({ type: "oauth" as const, access, refresh: "synthetic-refresh",
  expires: Date.now() + 3_600_000, accountId: "synthetic-account" });

function installFakeCodex(t: TestContext, dir: string, manifest: unknown) {
  const script = join(dir, "fake-codex.cjs");
  writeFileSync(join(dir, "codex-models.json"), JSON.stringify(manifest));
  writeFileSync(script, `
    const fs = require("node:fs");
    const path = require("node:path");
    fs.appendFileSync(path.join(__dirname, "calls"), process.argv.slice(2).join(" ") + "\\n");
    const value = process.argv[2] === "--version" ? "codex-cli 0.150.0"
      : fs.readFileSync(path.join(__dirname, "codex-models.json"), "utf8");
    process.stdout.write(value);
  `);
  if (process.platform === "win32") {
    writeFileSync(join(dir, "codex.cmd"), `@"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, "codex"), `#!/usr/bin/env node\nrequire("./fake-codex.cjs");\n`, { mode: 0o700 });
  }
  const original = process.env.PATH;
  process.env.PATH = dir + delimiter + (original ?? "");
  t.after(() => {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  });
}

async function loadExtension(dir: string, credentials: InMemoryCredentialStore, modelsStore: InMemoryModelsStore,
  modelsPath: string | null = null) {
  const runtime = await ModelRuntime.create({ modelsPath, credentials, modelsStore, refreshOnCreate: false });
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime: runtime, settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/model-catalog.ts", import.meta.url))],
    },
  });
  assert.deepEqual(services.diagnostics, []);
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  assert.equal(services.resourceLoader.getExtensions().extensions.length, 1);
  assert.equal(runtime.getProvider("openai")?.refreshModelsAuth, "credential");
  return runtime;
}

test("the shipped entry refreshes the two OAuth lists and restores the same account offline", async t => {
  const dir = temporaryDirectory(t);
  installFakeCodex(t, dir, { models: [] });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => oauth("public-token"));
  await credentials.modify("openai-codex", async () => oauth("legacy-token"));
  const store = new InMemoryModelsStore();
  const calls: string[] = [];
  let failPublic = false;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    const headers = new Headers(options.headers);
    calls.push(String(url));
    if (url.hostname === "pi.dev") {
      assert.equal(headers.has("authorization"), false);
      assert.equal(url.pathname, "/api/models/providers/openai");
      return new Response(null, { status: 404 });
    }
    assert.equal(options.redirect, "error");
    if (String(url) === openai) {
      assert.equal(headers.get("authorization"), "Bearer public-token");
      assert.equal(headers.has("chatgpt-account-id"), false);
      if (failPublic) return new Response(null, { status: 503 });
      return Response.json({ models: [visibleSol, { ...visibleSol, slug: "hidden-model", visibility: "hide" }] });
    }
    assert.equal(String(url), legacy);
    assert.equal(headers.get("authorization"), "Bearer legacy-token");
    assert.equal(headers.get("chatgpt-account-id"), "synthetic-account");
    return Response.json({ models: [{ ...visibleSol, context_window: 272_000 }] });
  });
  const runtime = await loadExtension(dir, credentials, store);
  assert.equal(calls.length, 0);
  assert.equal(runtime.getProvider("openai")?.auth.oauth?.loginLabel, "Sign in with ChatGPT");
  assert.ok(runtime.getProvider("openai")?.auth.apiKey);
  assert.deepEqual((await runtime.refresh({ providers: ["openai", "openai-codex"] })).errors, new Map());
  assert.deepEqual(calls.sort(), [openai, legacy].sort());
  const openaiModels = await runtime.getAvailable("openai");
  assert.deepEqual(openaiModels.map(model => model.id), ["gpt-6.2-sol"]);
  const sol = openaiModels[0];
  assert.equal(sol.api, "openai-responses");
  assert.equal(sol.contextWindow, 500_000);
  assert.equal(sol.maxTokens, 128_000);
  assert.equal(sol.cost.cacheRead, 0.1);
  assert.deepEqual(sol.input, ["text", "image"]);
  assert.deepEqual(getSupportedThinkingLevels(sol), ["low", "high", "max"]);
  const codexModels = await runtime.getAvailable("openai-codex");
  assert.deepEqual(codexModels.map(model => [model.id, model.api, model.contextWindow]), [
    ["gpt-6.2-sol", "openai-codex-responses", 272_000],
  ]);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "--version\n");
  assert.equal(JSON.stringify(await store.read("openai")).includes("public-token"), false);

  await runtime.refresh({ providers: ["openai"] });
  assert.equal(calls.length, 2, "recent catalog prevents redundant fetches");
  failPublic = true;
  const failed = await runtime.refresh({ providers: ["openai"], force: true });
  assert.match(failed.errors.get("openai")?.message ?? "", /HTTP 503/);
  assert.equal((await runtime.getAvailable("openai"))[0]?.id, "gpt-6.2-sol");
  const restarted = await loadExtension(dir, credentials, store);
  assert.equal((await restarted.getAvailable("openai"))[0]?.id, "gpt-6.2-sol");
  assert.equal(calls.length, 3, "offline startup restores a catalog without a network refresh");

  await credentials.modify("openai", async () => oauth("other-user"));
  await restarted.refresh({ providers: ["openai"], allowNetwork: false });
  assert.notEqual(restarted.getModel("openai", visibleSol.slug)?.name, visibleSol.display_name);
  await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-key" }));
  assert.deepEqual((await restarted.refresh({ providers: ["openai"] })).errors, new Map());
  assert.match(calls.at(-1) ?? "", /^https:\/\/pi\.dev\//);
  assert.ok((await restarted.getAllAvailable("openai")).some(model => model.type === "classifier"));
});

async function responsesFixture(t: TestContext) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-key" }));
  const runtime = await loadExtension(temporaryDirectory(t), credentials, new InMemoryModelsStore());
  const model = runtime.getProvider("openai")?.getModels().find(model => model.api === "openai-responses");
  assert.ok(model);

  const user = new AbortController();
  t.after(() => user.abort());
  let body: ReadableStreamDefaultController<string> | undefined;
  const send = (event: object) => {
    assert.ok(body);
    body.enqueue(`data: ${JSON.stringify(event)}\n\n`);
  };
  const add = (index: number) => send({ type: "response.output_item.added", output_index: index,
    item: { type: "function_call", id: `fc${index}`, call_id: `call${index}`, name: "codemode", arguments: "" } });
  const delta = (index: number, text: string) => {
    send({ type: "response.function_call_arguments.delta", output_index: index, delta: text });
  };
  const requests = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.ok(init?.signal);
    const signal = init.signal;
    const source = new ReadableStream<string>({
      start(controller) {
        body = controller;
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        send({ type: "response.created", response: { id: "fixture" } });
      },
    });
    return new Response(source.pipeThrough(new TextEncoderStream()), { headers: { "content-type": "text/event-stream" } });
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  t.mock.method(performance, "now", () => Date.now());
  const parsed = new Map<string, () => void>();
  const nextRaw = (type: string) => new Promise<void>(resolve => { parsed.set(type, resolve); });
  const response = runtime.streamSimple(model, {
    systemPrompt: "Test", messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
  }, { signal: user.signal, timeoutMs: 600_000, maxRetries: 0, onProviderStreamEvent(event) {
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") return;
    const resolve = parsed.get(event.type);
    parsed.delete(event.type);
    resolve?.();
  } });
  const output = response[Symbol.asyncIterator]();
  assert.equal((await output.next()).value?.type, "start");
  return { add, delta, send, nextRaw, response, output, user, requests,
    heartbeat: () => { body?.enqueue(": keep-alive\n\n"); send({ type: "ping" }); },
    close: () => body?.close() };
}

test("Responses tracks each unfinished tool's parameters, not keep-alives or other calls", { timeout: 5000 }, async t => {
  const f = await responsesFixture(t);
  f.add(0);
  f.delta(0, '{"code":"text(');
  assert.equal((await f.output.next()).value?.type, "toolcall_start");
  assert.equal((await f.output.next()).value?.type, "toolcall_delta");
  t.mock.timers.tick(119_000);
  f.delta(0, "1");
  assert.equal((await f.output.next()).value?.type, "toolcall_delta", "real argument progress keeps the stream alive");
  t.mock.timers.tick(119_000);
  f.add(1);
  f.delta(1, '{"code":"text(');
  assert.equal((await f.output.next()).value?.type, "toolcall_start");
  assert.equal((await f.output.next()).value?.type, "toolcall_delta");
  const ping = f.nextRaw("ping");
  f.heartbeat();
  await ping;
  t.mock.timers.tick(1_000);

  const result = await f.response.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /OpenAI Responses stream stalled.*tool arguments.*120s/);
  assert.deepEqual(result.content[0], { type: "toolCall", id: "call0|fc0", name: "codemode", arguments: { code: "text(1" } });
  assert.equal(f.user.signal.aborted, false);
  assert.equal(f.requests.mock.callCount(), 1);
});

test("encrypted reasoning and finished arguments do not impose a deadline on the rest of the response", { timeout: 5000 }, async t => {
  const f = await responsesFixture(t);
  const message = { type: "message", id: "msg", content: [{ type: "output_text", text: "Working" }] };
  f.send({ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } });
  f.send({ type: "response.output_text.delta", output_index: 0, delta: "Working" });
  assert.equal((await f.output.next()).value?.type, "text_start");
  assert.equal((await f.output.next()).value?.type, "text_delta");
  f.send({ type: "response.output_item.done", output_index: 0, item: message });
  assert.equal((await f.output.next()).value?.type, "text_end");

  const reasoning = { type: "reasoning", id: "rs1", summary: [], encrypted_content: "fixture-ciphertext" };
  f.send({ type: "response.output_item.added", output_index: 1, item: reasoning });
  assert.equal((await f.output.next()).value?.type, "thinking_start");
  t.mock.timers.tick(121_000);
  f.send({ type: "response.output_item.done", output_index: 1, item: reasoning });
  assert.equal((await f.output.next()).value?.type, "thinking_end");

  f.add(2);
  f.delta(2, '{"code":"text(1)"}');
  assert.equal((await f.output.next()).value?.type, "toolcall_start");
  assert.equal((await f.output.next()).value?.type, "toolcall_delta");
  const item = { type: "function_call", id: "fc2", call_id: "call2", name: "codemode", arguments: '{"code":"text(1)"}' };
  const argsDone = f.nextRaw("response.function_call_arguments.done");
  f.send({ type: "response.function_call_arguments.done", output_index: 2, arguments: item.arguments });
  await argsDone;
  t.mock.timers.tick(121_000);
  f.send({ type: "response.output_item.done", output_index: 2, item });
  f.send({ type: "response.completed", response: { status: "completed", output: [message, reasoning, item] } });
  f.close();
  const result = await f.response.result();
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.content.at(-1), { type: "toolCall", id: "call2|fc2", name: "codemode", arguments: { code: "text(1)" } });
});

test("offline startup can restore the saved model after Pi rotates the OAuth tokens", async t => {
  const dir = temporaryDirectory(t), credentials = new InMemoryCredentialStore(), store = new InMemoryModelsStore();
  const provider = "openai", id = visibleSol.slug;
  const initial = oauth("initial-token");
  await credentials.modify(provider, async () => initial);
  const tokens: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(String(url), openai);
    const auth = new Headers(options.headers).get("authorization");
    assert.ok(auth);
    tokens.push(auth);
    return auth === "Bearer initial-token" ? Response.json({ models: [visibleSol] }) : new Response(null, { status: 503 });
  });
  const runtime = await loadExtension(dir, credentials, store);
  assert.equal((await runtime.refresh({ providers: [provider] })).errors.size, 0);
  const model = runtime.getModel(provider, id);
  assert.ok(model);

  const oldStore = new InMemoryModelsStore();
  const scope = createHash("sha256").update(JSON.stringify([initial.access, initial.accountId])).digest("hex");
  const oldEntry = { models: [], metisAccountCatalog: { scope, models: [model], checkedAt: Date.now() } };
  await oldStore.write(provider, oldEntry);
  const oldCatalog = () => loadExtension(dir, credentials, oldStore);
  assert.equal((await oldCatalog()).getModel(provider, id)?.name, visibleSol.display_name, "matching older catalog opens offline");

  const auth = runtime.getProvider(provider)?.auth.oauth;
  assert.ok(auth);
  const rotate = t.mock.method(auth, "refresh", async (credential: OAuthCredential) => ({
    ...credential, access: "rotated-token", refresh: "rotated-refresh", expires: initial.expires,
  }));
  await credentials.modify(provider, async () => ({ ...initial, expires: 0 }));
  const failed = await runtime.refresh({ providers: [provider], force: true });
  assert.match(failed.errors.get(provider)?.message ?? "", /HTTP 503/);
  assert.equal(rotate.mock.callCount(), 1, "refresh runs through Pi's actual credential broker");
  const cold = await loadExtension(dir, credentials, store);
  assert.equal(cold.getModel(provider, id)?.name, visibleSol.display_name, "the resumed session can find its saved model");
  assert.ok((await cold.getAvailable(provider)).some(model => model.id === id && model.name === visibleSol.display_name));
  assert.notEqual((await oldCatalog()).getModel(provider, id)?.name, visibleSol.display_name, "unproven legacy cache stays isolated");

  const config = join(dir, "custom-models.json");
  writeFileSync(config, JSON.stringify({ providers: { openai: { baseUrl: "https://custom.invalid/v1" } } }));
  assert.notEqual((await loadExtension(dir, credentials, store, config)).getModel(provider, id)?.name, visibleSol.display_name);
  assert.deepEqual(tokens, ["Bearer initial-token", "Bearer rotated-token"], "offline startup never requests either catalog");
  const rotated = await credentials.read(provider);
  assert.ok(rotated?.type === "oauth");
  for (const unrelated of [{ ...rotated, accountId: "other-account" }, { ...rotated, access: "external-token" }]) {
    await credentials.modify(provider, async () => unrelated);
    assert.ok(!(await cold.getAvailable(provider)).some(model => model.name === visibleSol.display_name));
  }
  const login = cold.getProvider(provider)?.auth.oauth;
  assert.ok(login?.login);
  t.mock.method(login, "login", async () => rotated);
  await cold.login(provider, "oauth", { async prompt() { throw new Error("unexpected prompt"); }, notify() {} });
  assert.ok(!(await cold.getAvailable(provider)).some(model => model.name === visibleSol.display_name),
    "a fresh login with identical tokens is still distinct");
  await cold.refresh({ providers: [provider], allowNetwork: false });
  assert.notEqual(cold.getModel(provider, id)?.name, visibleSol.display_name);
});

test("local Codex fills exact-slug fields without extending the account inventory", async t => {
  const dir = temporaryDirectory(t);
  const metadata = { slug: "fresh-model", visibility: "list", context_window: 300_000, max_output_tokens: 32_000,
    input_modalities: ["text"], supported_reasoning_levels: [{ effort: "high" }],
    cost: { input: 1, output: 2, cache_read: 0.05, cache_write: 1.2 } };
  const second = { ...metadata, slug: "second-model" };
  installFakeCodex(t, dir, { models: [metadata, second, { ...metadata, slug: "foreign-account-model" }] });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => oauth("public-token"));
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(String(url), openai);
    return Response.json({ models: [
      { slug: metadata.slug, visibility: "list", context_window: 200_000 },
      visibleSol,
      { slug: second.slug, visibility: "list" },
    ] });
  });
  const runtime = await loadExtension(dir, credentials, new InMemoryModelsStore());
  assert.deepEqual((await runtime.refresh({ providers: ["openai"] })).errors, new Map());
  const models = await runtime.getAvailable("openai");
  assert.deepEqual(models.map(model => [model.id, model.contextWindow, model.maxTokens, model.cost.cacheWrite]), [
    ["fresh-model", 200_000, 32_000, 1.2],
    ["gpt-6.2-sol", 500_000, 128_000, 2.5],
    ["second-model", 300_000, 32_000, 1.2],
  ]);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "debug models\n");
});

test("pi update --models forces an enabled Metis catalog refresh through the packaged CLI", async t => {
  const dir = temporaryDirectory(t);
  const metadata = { slug: "new-model", visibility: "list", context_window: 300_000, max_output_tokens: 32_000,
    input_modalities: ["text"], supported_reasoning_levels: [{ effort: "high" }],
    cost: { input: 1, output: 2, cache_read: 0.05, cache_write: 1.2 } };
  installFakeCodex(t, dir, { models: [metadata] });
  const agentDir = join(dir, "agent");
  const packageDir = join(dir, "metis");
  for (const path of [agentDir, join(packageDir, "extensions"), join(packageDir, "src")]) {
    mkdirSync(path, { recursive: true });
  }
  cpSync(new URL("../../extensions/model-catalog.ts", import.meta.url), join(packageDir, "extensions", "model-catalog.ts"));
  cpSync(new URL("../../src/model-catalog/", import.meta.url), join(packageDir, "src", "model-catalog"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@rycen7822/metis-pi", pi: { extensions: ["./extensions/*.ts"] },
  }));
  writeFileSync(join(packageDir, "extensions", "unrelated.ts"), 'throw new Error("unrelated extension executed");');
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    openai: oauth("public-token"), "openai-codex": oauth("legacy-token"),
  }));
  const settings = join(agentDir, "settings.json");
  writeFileSync(settings, JSON.stringify({ packages: [packageDir] }));
  const requests = join(dir, "requests");
  const hook = join(dir, "catalog-fetch.mjs");
  writeFileSync(hook, `
    import assert from "node:assert/strict";
    import { appendFileSync } from "node:fs";
    const fetch = async (input, options) => {
      const url = String(input);
      const headers = new Headers(options.headers);
      appendFileSync(${JSON.stringify(requests)}, url + "\\n");
      if (new URL(url).hostname === "pi.dev") {
        assert.equal(headers.has("authorization"), false);
        return new Response(null, { status: 404 });
      }
      if (url === ${JSON.stringify(openai)}) {
        assert.equal(headers.get("authorization"), "Bearer public-token");
      } else {
        assert.equal(url, ${JSON.stringify(legacy)});
        assert.equal(headers.get("authorization"), "Bearer legacy-token");
      }
      return Response.json({ models: [{ slug: "new-model", visibility: "list", context_window: 200_000 }] });
    };
    // Keep the fake transport in place when the CLI installs Undici's globals.
    Object.defineProperty(globalThis, "fetch", { get: () => fetch, set: () => {} });
  `);
  const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
  const run = promisify(execFile);
  const update = () => run(process.execPath, ["--import", pathToFileURL(hook).href, cli, "update", "--models"], {
    cwd: dir, timeout: 20_000, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT,
      // Identify this isolated process after Pi overwrites argv, so concurrent SDK retention tests can exclude it.
      HOME: dir, USERPROFILE: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PI_CODING_AGENT_DIR: agentDir, PI_MANAGED_INSTALL_ROOT: dir },
  });
  for (let refresh = 0; refresh < 2; refresh++) {
    const { stdout } = await update();
    assert.match(stdout, /Model catalogs refreshed/);
  }
  assert.deepEqual(readFileSync(requests, "utf8").trim().split("\n").sort(), [openai, legacy, openai, legacy].sort());
  assert.equal(readFileSync(join(dir, "calls"), "utf8").match(/debug models/g)?.length, 4);
  const store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
  for (const provider of ["openai", "openai-codex"]) {
    assert.deepEqual(store[provider].metisAccountCatalog.models.map((model: { id: string; maxTokens: number }) =>
      [model.id, model.maxTokens]), [["new-model", 32_000]]);
  }

  writeFileSync(requests, "");
  writeFileSync(settings, JSON.stringify({ packages: [{ source: packageDir, extensions: ["-extensions/model-catalog.ts"] }] }));
  await update();
  assert.deepEqual(readFileSync(requests, "utf8").trim().split("\n").map(url => new URL(url).hostname), ["pi.dev", "pi.dev"]);
});
