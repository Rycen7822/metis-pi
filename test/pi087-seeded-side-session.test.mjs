#!/usr/bin/env node
/**
 * Host contract behind the external /btw Pi 0.87 fix, without depending on the extension file.
 *
 * A side session is created from a real `SessionManager` that was seeded before
 * `createAgentSession`. The capture hook records the exact context the real agent loop builds for
 * the model, so the assertion is about the actual request, not `agent.state.messages`. Everything
 * is offline: `globalThis.fetch` throws and the stream function only records.
 *
 * The /btw seeding fix relies on this: history placed in the SessionManager before the session is
 * created reaches every request exactly once, including on hosts that rebuild context per request.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./helpers/temp-dir.mjs";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AuthStorage } = await import(new URL("./core/auth-storage.js", hostEntry));
const { ModelRuntime } = await import(new URL("./core/model-runtime.js", hostEntry));

const countOf = (value, needle) => JSON.stringify(value).split(needle).length - 1;

test("a session seeded before creation sends that history on every request exactly once", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("NETWORK_DISABLED");
	});
	const temp = temporaryDirectory(t, "pi-seeded-session-");
	const agentDir = join(temp, "agent");
	mkdirSync(agentDir);
	const model = getBuiltinModels("openai")[0];
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "offline-fake" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null, allowModelNetwork: false });
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
		cacheWarming: { mode: "off" },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: temp,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.inMemory(temp);
	sessionManager.appendMessage({ role: "user", content: "SEED_HISTORY_SENTINEL", timestamp: 1 });

	const { session } = await createAgentSession({
		cwd: temp,
		agentDir,
		sessionManager,
		model,
		modelRuntime,
		settingsManager,
		resourceLoader,
		tools: [],
	});
	t.after(() => session.dispose());
	const captured = [];
	session.agent.streamFunction = (_model, context) => {
		captured.push(structuredClone(context));
		throw new Error("OFFLINE_CAPTURE_COMPLETE");
	};

	await session.prompt("QUESTION_ONE").catch(() => {});
	assert.equal(captured.length, 1, "the first prompt must reach the model");
	assert.equal(countOf(captured[0], "SEED_HISTORY_SENTINEL"), 1, "the seed is part of the first request");
	assert.equal(countOf(captured[0], "QUESTION_ONE"), 1, "the first question appears exactly once");

	await session.prompt("QUESTION_TWO").catch(() => {});
	assert.equal(captured.length, 2, "the second prompt must reach the model");
	assert.equal(countOf(captured[1], "SEED_HISTORY_SENTINEL"), 1, "later requests keep the seed exactly once");
	assert.equal(countOf(captured[1], "QUESTION_TWO"), 1, "the second question appears exactly once");
});
