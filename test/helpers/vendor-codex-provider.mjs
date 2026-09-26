// Offline request capture through the built provider; the full extension is owned by its entry contract.
// Payload capture stops before transport. Suites explicitly install their network guard.
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";

import { registerOpenAICodexCustomProvider } from "../../vendor/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js";

export const FAKE_API_KEY = "x." + Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } }),
).toString("base64url") + ".x";

// Explicit per-test resource ownership; importing model/auth data installs no hooks.
export function disableNetwork(t) {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("NETWORK_DISABLED"); });
}

// Request/replay suites need only the provider's stream boundary, not the extension entry.
function protocolProvider() {
	let provider;
	registerOpenAICodexCustomProvider({
		registerProvider: (_id, registered) => { provider = registered; },
		on() {},
	}, {});
	return provider;
}

/** Capture the request body the registered `openai-codex` provider builds for `context`. */
export async function captureBody(model, context, options = {}) {
	const capture = await captureRegistration();
	const result = await capture.registration.streamSimple(model, context, {
		apiKey: FAKE_API_KEY,
		...options,
	}).result();
	assert.equal(capture.bodies.length, 1, `expected one final payload (stream ended with: ${result?.errorMessage ?? "no error"})`);
	return capture.bodies[0];
}

export function modelNamed(id) {
	const models = getBuiltinModels("openai-codex");
	const model = models.find((candidate) => candidate.id === id);
	assert.ok(model, `expected builtin openai-codex model ${id}`);
	return model;
}

export function captureSession(model, sm) {
	const context = buildSessionContext(sm.getEntries(), sm.getLeafId());
	return captureBody(model, normalizeContext({ messages: convertToLlm(context.messages) }));
}

export const declaredToolNames = (body) => body.tools?.map(({ name }) => name) ?? [];
export const inPlaceToolItems = (input) => input.filter(({ type }) =>
	["additional_tools", "tool_search_call", "tool_search_output"].includes(type));
export const kindsOf = (input) => input.map((item) =>
	item.role && (!item.type || item.type === "message") ? `message:${item.role}` : item.type);

/** Capture after the adapter's payload hook, before any transport; count even uncaptured attempts. */
export async function captureRegistration(registered = protocolProvider()) {
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
