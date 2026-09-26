import assert from "node:assert/strict";
import test from "node:test";
import {
	captureCanonicalSessionToken,
	clearCanonicalSessions,
	recordCanonicalSessionResponse,
	resolveCanonicalCompactionPromptInput,
	validateCanonicalSessionRequest,
} from "../../vendor/pi-codex-conversion/dist/providers/openai-codex/session-continuity.js";

const identity = { url: "https://example.invalid/responses", accountId: "offline-account" };
const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
const response = { role: "assistant", content: [{ type: "output_text", text: "answer" }] };

function fixture(t, sessionId = "continuity-memory") {
	t.after(() => clearCanonicalSessions(sessionId));
	const requestBody = { model: "offline-model", input: [user("start")] };
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [response] });
	return { sessionId, requestBody, prepared: { ...requestBody, input: [...requestBody.input, response, user("next")] } };
}

test("ordinary canonical validation does not clone replay history", (t) => {
	const { sessionId, prepared } = fixture(t);
	t.mock.method(globalThis, "structuredClone", () => { throw new Error("validation must not deep clone"); });
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, prepared), "validated");
	assert.equal(validateCanonicalSessionRequest(sessionId, "other", identity.accountId, prepared), "identity_mismatch");
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, { ...prepared, model: "other" }), "identity_mismatch");
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, { ...prepared, input: [] }), "input_shorter_than_baseline");
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, { ...prepared, input: [user("different"), response] }), "request_prefix_mismatch");
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, { ...prepared, input: [user("start"), user("not the response")] }), "response_prefix_mismatch");
	assert.equal(validateCanonicalSessionRequest("missing", identity.url, identity.accountId, prepared), undefined);
});

for (const [name, prefix, normalizedText] of [
	["ordinary", [], "start"],
	["normalized", [], "normalized"],
	["Responses Lite", [{ type: "additional_tools", tools: [] }, { role: "developer", content: "tools" }], "start"],
]) {
	test(`${name}: validation and replay own the raw request, normalized view, response and tail`, (t) => {
		const { sessionId, requestBody } = fixture(t);
		requestBody.input.unshift(...prefix);
		const normalized = { ...requestBody, input: [...prefix, user(normalizedText)] };
		const output = structuredClone(response);
		const expected = [...structuredClone(requestBody.input), response, user("tail")];
		recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, reconstructedRequestBody: normalized, responseItems: [output] });
		requestBody.input.at(-1).content[0].text = "caller mutation";
		normalized.input.at(-1).content[0].text = "normalized mutation";
		output.content[0].text = "response mutation";
		const reconstruction = [user(normalizedText), response, user("tail")];
		assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, {
			model: requestBody.model, input: [...prefix, ...reconstruction],
		}), "validated");
		const replay = () => resolveCanonicalCompactionPromptInput(sessionId, requestBody.model, identity, reconstruction);
		assert.deepEqual(replay(), { decision: "validated", input: expected });
		for (const item of replay().input.filter((item) => Array.isArray(item.content))) item.content[0].text = "consumer mutation";
		assert.deepEqual(replay().input, expected);
		assert.equal(reconstruction.at(-1).content[0].text, "tail");
	});
}

test("stale response tokens and explicit clearing cannot revive an old canonical baseline", (t) => {
	const { sessionId, requestBody } = fixture(t);
	const first = captureCanonicalSessionToken(sessionId);
	const second = captureCanonicalSessionToken(sessionId);
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [user("new")], token: second });
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [user("old")], token: first });
	const prepared = { ...requestBody, input: [...requestBody.input, user("new")] };
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, prepared), "validated");
	clearCanonicalSessions(sessionId);
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [response], token: second });
	assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, prepared), undefined);
});
