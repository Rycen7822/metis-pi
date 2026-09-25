// Shared offline capture harness for the vendored Codex transport tests.
//
// Loads the **built** entry, starts its provider registration against a fake Pi catalog,
// and captures the request body it would send. Nothing opens a transport: the capture
// hook throws first and `globalThis.fetch` is disabled.
import assert from "node:assert/strict";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const ENTRY = new URL("../../vendor/pi-codex-conversion/dist/index.js", import.meta.url).href;

export const FAKE_API_KEY = "x." + Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } }),
).toString("base64url") + ".x";

// Any transport that got past the payload capture would try to reach the network here.
globalThis.fetch = async () => {
	throw new Error("NETWORK_DISABLED");
};

let loaded;
export async function loadRegistration() {
	loaded ??= (async () => {
		const extension = (await import(ENTRY)).default;
		assert.equal(typeof extension, "function", "vendored entry must export an extension factory");
		const calls = { providers: [], tools: [], sessionStart: [] };
		const recorded = {
			events: { emit: () => {}, on: () => {}, off: () => {} },
			on: (name, handler) => {
				if (name === "session_start") calls.sessionStart.push(handler);
			},
			registerTool: (options) => calls.tools.push(options),
			registerProvider: (...args) => calls.providers.push(args),
			getAllTools: () => [],
			getActiveTools: () => [],
			getSettings: () => ({}),
			getFlag: () => undefined,
			setFlag: () => {},
		};
		const pi = new Proxy(recorded, {
			get(target, property) {
				if (property in target) return target[property];
				if (typeof property !== "string") return undefined;
				return (...args) => {
					calls[property] = calls[property] ?? [];
					calls[property].push(args.length === 1 ? args[0] : args);
					return undefined;
				};
			},
		});
		await extension(pi);
		const initial = calls.providers.find(([name]) => name === "openai-codex");
		assert.ok(initial, "vendored entry must overlay Pi's openai-codex provider");
		assert.equal(initial[1].models, undefined, "transport overlay must inherit Pi's model catalog");
		const hostModels = [...getBuiltinModels("openai-codex")];
		let refreshCount = 0;
		const hostProvider = { getModels: () => hostModels, refreshModels: async () => { refreshCount++; } };
		const installProvider = calls.sessionStart.find((handler) => handler.name === "installNativeCodexProvider");
		assert.ok(installProvider, "provider registration must run at session start");
		await installProvider({}, { modelRegistry: { getProvider: () => hostProvider } });
		const registration = calls.providers.find(([first]) => first?.id === "openai-codex");
		assert.ok(registration, "vendored entry must register the openai-codex provider");
		await installProvider({}, { modelRegistry: { getProvider: () => hostProvider } });
		assert.equal(calls.providers.filter(([first]) => first?.id === "openai-codex").length, 1, "later sessions must reuse the native provider");
		await registration[0].refreshModels({});
		assert.equal(refreshCount, 1, "provider must delegate catalog refresh to Pi");
		const futureModel = { ...hostModels[0], id: "future-codex-model" };
		hostModels.push(futureModel);
		assert.ok(registration[0].getModels().some(({ id }) => id === futureModel.id), "provider must follow Pi's live catalog");
		const reserve = registration[0].getModels().find(({ id }) => id === "gpt-reserve");
		assert.ok(reserve, "provider must keep Luna Reserve resolvable");
		assert.ok(!registration[0].filterModels(registration[0].getModels(), {}).some(({ id }) => id === reserve.id), "Luna Reserve must remain hidden from the picker");
		return registration[0];
	})();
	return loaded;
}

/** Capture the request body the registered `openai-codex` provider builds for `context`. */
export async function captureBody(model, context, options = {}) {
	let payload;
	const provider = await loadRegistration();
	const stream = provider.streamSimple(model, context, {
		apiKey: FAKE_API_KEY,
		transport: "sse",
		...options,
		onPayload(body) {
			payload = body;
			throw new Error("OFFLINE_CAPTURE_COMPLETE");
		},
	});
	const result = await stream.result();
	assert.ok(payload, `onPayload must capture a body (stream ended with: ${result?.errorMessage ?? "no error"})`);
	return payload;
}

export function modelNamed(id) {
	const models = getBuiltinModels("openai-codex");
	const model = models.find((candidate) => candidate.id === id);
	assert.ok(model, `expected builtin openai-codex model ${id}`);
	return model;
}

/**
 * Run `executeRemoteCompactionV2` through the registered provider and return the **final** request
 * body, i.e. what the adapter's own `onPayload` produced. The capture hook throws before any
 * transport is opened, so nothing is sent and no credentials are used.
 */
export async function withFinalPayloadCapture(run) {
	const registered = await loadRegistration();
	let captured;
	const registration = {
		...registered,
		streamSimple: (model, context, options) => registered.streamSimple(model, context, {
			...options,
			transport: "sse",
			onPayload: async (body) => {
				captured = await options.onPayload(body);
				throw new Error("OFFLINE_CAPTURE_COMPLETE");
			},
		}),
	};
	await run(registration);
	assert.ok(captured, "the adapter's final payload hook must run before any transport is opened");
	return captured;
}
