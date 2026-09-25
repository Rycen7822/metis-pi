import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalCompactionPromptInput,
	captureCanonicalSessionToken,
	clearCanonicalSessions,
	recordCanonicalSessionResponse,
	resolveCanonicalCompactionPromptInput,
	validateCanonicalSessionRequest,
} from "../vendor/pi-codex-conversion/src/providers/openai-codex/session-continuity.ts";

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

test("recording and actual compaction replay retain independent nested ownership", (t) => {
	const { sessionId, requestBody, prepared } = fixture(t);
	requestBody.input[0].content[0].text = "caller mutation";
	const expected = [user("start"), response];
	assert.deepEqual(canonicalCompactionPromptInput(sessionId, prepared.model, identity), expected);
	const reconstruction = [...expected, user("tail")];
	const replay = resolveCanonicalCompactionPromptInput(sessionId, prepared.model, identity, reconstruction);
	assert.equal(replay.decision, "validated");
	assert.deepEqual(replay.input, reconstruction);
	replay.input[0].content[0].text = "replay request mutation";
	replay.input[1].content[0].text = "replay response mutation";
	replay.input[2].content[0].text = "replay tail mutation";
	assert.deepEqual(canonicalCompactionPromptInput(sessionId, prepared.model, identity), expected);
	assert.equal(reconstruction[2].content[0].text, "tail");
});

for (const variant of ["implicit", "same-input", "reconstructed"]) {
	test(`canonical ${variant} views share only their owned input baseline`, (t) => {
		const sessionId = `baseline-${variant}`;
		t.after(() => clearCanonicalSessions(sessionId));
		const requestBody = { model: "offline-model", input: [user("raw")] };
		const reconstructedRequestBody = variant === "implicit" ? undefined : {
			...requestBody, input: variant === "same-input" ? requestBody.input : [user("normalized")],
		};
		const clone = globalThis.structuredClone;
		const snapshots = [];
		t.mock.method(globalThis, "structuredClone", (value) => {
			const result = clone(value);
			if (value.requestBody && value.reconstructedRequestInput) snapshots.push(result);
			return result;
		});
		// Even an aliased caller response must not merge the independent response snapshot.
		recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, reconstructedRequestBody, responseItems: requestBody.input });
		assert.equal(snapshots.length, 1);
		const snapshot = snapshots[0];
		assert.equal(snapshot.requestBody.input === snapshot.reconstructedRequestInput, variant !== "reconstructed");
		assert.notEqual(snapshot.requestBody.input, requestBody.input);
		requestBody.input[0].content[0].text = "caller mutation";
		if (reconstructedRequestBody) reconstructedRequestBody.input[0].content[0].text = "another mutation";
		const expectedInput = [user(variant === "reconstructed" ? "normalized" : "raw"), user("raw")];
		assert.equal(validateCanonicalSessionRequest(sessionId, identity.url, identity.accountId, {
			model: requestBody.model, input: expectedInput,
		}), "validated");
		const replay = canonicalCompactionPromptInput(sessionId, requestBody.model, identity);
		assert.deepEqual(replay, [user("raw"), user("raw")]);
		replay[0].content[0].text = "replay mutation";
		assert.equal(replay[1].content[0].text, "raw");
		assert.deepEqual(canonicalCompactionPromptInput(sessionId, requestBody.model, identity), [user("raw"), user("raw")]);
	});
}

test("Responses Lite prefix validation still replays canonical raw input and independently cloned tail", (t) => {
	const sessionId = "lite-continuity-memory";
	t.after(() => clearCanonicalSessions(sessionId));
	const prefix = [{ type: "additional_tools", tools: [] }, { role: "developer", content: "tools" }];
	const requestBody = { model: "offline-model", input: [...prefix, user("start")] };
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [response] });
	const replay = resolveCanonicalCompactionPromptInput(sessionId, requestBody.model, identity, [user("start"), response, user("tail")]);
	assert.equal(replay.decision, "validated");
	assert.deepEqual(replay.input, [...requestBody.input, response, user("tail")]);
});

test("stale response tokens and explicit clearing cannot revive an old canonical baseline", (t) => {
	const { sessionId, requestBody } = fixture(t);
	const first = captureCanonicalSessionToken(sessionId);
	const second = captureCanonicalSessionToken(sessionId);
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [user("new")], token: second });
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [user("old")], token: first });
	assert.deepEqual(canonicalCompactionPromptInput(sessionId, requestBody.model, identity), [...requestBody.input, user("new")]);
	clearCanonicalSessions(sessionId);
	recordCanonicalSessionResponse({ sessionId, ...identity, requestBody, responseItems: [response], token: second });
	assert.equal(canonicalCompactionPromptInput(sessionId, requestBody.model, identity), undefined);
});
