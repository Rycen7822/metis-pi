// Shared offline capture harness for the vendored Codex transport tests.
//
// Loads the **built** entry, starts its provider registration against a fake Pi catalog,
// and captures the request body it would send. Nothing opens a transport: the capture
// hook throws first and `globalThis.fetch` is disabled.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";

const ENTRY = new URL("../../vendor/pi-codex-conversion/dist/index.js", import.meta.url).href;

export const FAKE_API_KEY = "x." + Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } }),
).toString("base64url") + ".x";

// The guard belongs to this test file's lifetime, not module import.
let originalFetch;
before(() => {
	originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("NETWORK_DISABLED"); };
});
after(() => { globalThis.fetch = originalFetch; });

let loaded;
export async function registrationHarness() {
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
		const hostModels = [...getBuiltinModels("openai-codex")];
		let refreshCount = 0;
		const hostProvider = { getModels: () => hostModels, refreshModels: async () => { refreshCount++; } };
		const installProvider = calls.sessionStart.find((handler) => handler.name === "installNativeCodexProvider");
		assert.ok(installProvider, "missing native provider session hook");
		await installProvider({}, { modelRegistry: { getProvider: () => hostProvider } });
		const registration = calls.providers.find(([first]) => first?.id === "openai-codex");
		assert.ok(registration, "missing native provider registration");
		return { registration: registration[0], calls, hostModels, hostProvider, installProvider, get refreshCount() { return refreshCount; } };
	})();
	return loaded;
}

export async function loadRegistration() {
	return (await registrationHarness()).registration;
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

export function captureSession(model, entries, leafId) {
	const context = buildSessionContext(entries, leafId);
	return captureBody(model, normalizeContext({ messages: convertToLlm(context.messages) }));
}

export const declaredToolNames = (body) => body.tools?.map(({ name }) => name) ?? [];
export const inPlaceToolItems = (input) => input.filter(({ type }) =>
	["additional_tools", "tool_search_call", "tool_search_output"].includes(type));
export const kindsOf = (input) => input.map((item) =>
	item.role && (!item.type || item.type === "message") ? `message:${item.role}` : item.type);

/** Capture after the adapter's payload hook, before any transport; count even uncaptured attempts. */
export async function captureRegistration() {
	const registered = await loadRegistration();
	const bodies = [];
	let calls = 0;
	const registration = {
		...registered,
		streamSimple(model, context, options = {}) {
			calls++;
			return registered.streamSimple(model, context, {
				...options, transport: "sse",
				async onPayload(body) {
					bodies.push((await options.onPayload?.(body)) ?? body);
					throw new Error("OFFLINE_CAPTURE_COMPLETE");
				},
			});
		},
	};
	return { registration, bodies, get calls() { return calls; } };
}
