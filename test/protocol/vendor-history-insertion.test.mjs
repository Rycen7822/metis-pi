import assert from "node:assert/strict";
import test from "node:test";
import { insertReconstructedMessages } from "../../src/codex/context/history-insertion.ts";

const message = (id) => ({ role: "user", timestamp: 1, content: id });
const key = (value) => value.content.startsWith("same") ? "same" : value.content;

test("reconstruction consumes duplicate identities in order and preserves original objects", () => {
	const first = message("same-original-1");
	const second = message("same-original-2");
	const last = message("last");
	const before = message("before");
	const middle = message("middle");
	const after = message("after");
	const result = insertReconstructedMessages([first, second, last],
		[before, message("same-rebuilt-1"), middle, message("same-rebuilt-2"), last, after], key, () => true);
	assert.deepEqual(result, [before, first, middle, second, last, after]);
	assert.equal(result[1], first);
	assert.equal(result[3], second);
});

test("reconstruction skips unselected additions even without a surviving anchor", () => {
	const kept = message("kept");
	const selected = message("selected");
	const ignored = message("ignored");
	assert.deepEqual(insertReconstructedMessages([kept], [selected, ignored], key,
		(value) => value === selected), [selected, kept]);
	assert.deepEqual(insertReconstructedMessages([], [ignored, selected], key,
		(value) => value === selected), [selected]);
	const system = { ...message("system"), role: "system" };
	assert.deepEqual(insertReconstructedMessages([system, kept], [selected, system, kept], key,
		(value) => value === selected), [system, selected, kept]);
	assert.deepEqual(insertReconstructedMessages([system], [selected], key,
		(value) => value === selected), [system, selected]);
});
