// Shared offline capture harness for the vendored Codex transport tests.
//
// Loads the **built** entry, takes the provider it registers, and captures the request body
// that provider would send. Nothing opens a transport: the capture hook throws first and
// `globalThis.fetch` is disabled.
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
		const calls = { providers: [], tools: [] };
		const recorded = {
			events: { emit: () => {}, on: () => {}, off: () => {} },
			on: () => {},
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
		const registration = calls.providers.find(([first]) => first?.id === "openai-codex");
		assert.ok(registration, "vendored entry must register the openai-codex provider");
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
