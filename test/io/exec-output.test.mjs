import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ExecOutputBuffer } from "../../vendor/pi-codex-conversion/dist/tools/exec/output-buffer.js";
import { consumeOutput, peekOutputSince, peekUnconsumedOutput } from "../../vendor/pi-codex-conversion/dist/tools/exec/output.js";
import { trackExecSpools } from "../helpers/exec.mjs";

const Mi = 1024 * 1024;

function bufferFor(t, maxChars) {
	const buffer = new ExecOutputBuffer(maxChars);
	t.after(() => buffer.dispose());
	return buffer;
}

test("resident and spooled buffers preserve the old character budget, ordering and surrogate boundaries", (t) => {
	for (const cap of [1024, Mi + 37]) {
		const buffer = bufferFor(t, cap);
		let totalChars = 0;
		for (const [text, reference] of [
			["first\n", "first\n"],
			["a".repeat(cap - 9), "first\n" + "a".repeat(cap - 9)],
			["🙂", "first\n" + "a".repeat(cap - 9) + "🙂"],
			["B".repeat(19), "a".repeat(cap - 21) + "🙂" + "B".repeat(19)],
			["💡".repeat(cap), "💡".repeat(Math.floor(cap / 2))],
			["last\n", "💡".repeat(Math.floor((cap - 5) / 2)) + "last\n"],
		]) {
			totalChars += text.length;
			buffer.append(text);
			assert.equal(buffer.slice(), reference);
			assert.equal(buffer.startOffset, totalChars - reference.length);
			assert.equal(buffer.endOffset, totalChars);
			assert.equal(buffer.slice(-301), reference.slice(-301));
			assert.equal(buffer.slice(3, 91), reference.slice(3, 91));
			assert.equal(buffer.slice(3.5, 91.2), reference.slice(3.5, 91.2));
			if (buffer.spool) assert.ok(fs.fstatSync(buffer.spool.fd).size <= cap * 2, "disk ring does not grow with lifetime output");
		}
	}
});

for (const scenario of [
	{ name: "delivery only", cap: 4 * Mi, text: "prefix\n" + "x".repeat(3 * Mi) + "🙂".repeat(300),
		peekTokens: 65, peeked: "🙂".repeat(130), consumeTokens: 65, consumed: "🙂".repeat(130) },
	{ name: "retention plus delivery", cap: Mi + 13, text: "a".repeat(2 * Mi) + "🙂" + "z".repeat(255),
		peekTokens: 64, peeked: "z".repeat(255), consumeTokens: Mi, consumed: "a".repeat(Mi - 244) + "🙂" + "z".repeat(255) },
]) test(`tail consumption: ${scenario.name} preserves counts, surrogate boundaries and unread offsets`, (t) => {
	const buffer = bufferFor(t, scenario.cap);
	buffer.append(scenario.text);
	const state = { buffer, emittedOffset: 0 };
	const read = t.mock.method(fs, "readSync");
	const original_token_count = Math.ceil(scenario.text.length / 4);
	assert.deepEqual(peekUnconsumedOutput(state, scenario.peekTokens), { output: scenario.peeked, original_token_count });
	const bytes = read.mock.calls.reduce((total, call) => total + call.arguments[3], 0);
	assert.ok(bytes <= (scenario.peekTokens * 4 + 1) * 2, "read only the requested tail, never materialize the full spool");
	assert.equal(state.emittedOffset, 0);
	assert.deepEqual(consumeOutput(state, scenario.consumeTokens), { output: scenario.consumed, original_token_count });
	assert.deepEqual(consumeOutput(state, 65), { output: "" });
	const baseline = buffer.endOffset;
	buffer.append("later\n");
	assert.deepEqual(peekOutputSince(state, baseline, 65), { output: "later\n", original_token_count: 2 });
	assert.deepEqual(consumeOutput(state, 65), { output: "later\n", original_token_count: 2 });
});

test("partial spool writes fall back without losing retained output and release the file", (t) => {
	const buffer = bufferFor(t, Mi + 300);
	buffer.append("a".repeat(Mi + 200));
	const { directory, fd } = buffer.spool;
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
		assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
	}
	const write = fs.writeSync;
	let calls = 0;
	t.mock.method(fs, "writeSync", (...args) => {
		if (calls++ === 0) return write(args[0], args[1], args[2], 17, args[4]);
		throw new Error("ENOSPC injected after a partial write");
	});
	buffer.append("b".repeat(1000));
	assert.equal(buffer.slice(), "a".repeat(Mi - 700) + "b".repeat(1000));
	assert.equal(buffer.spool, undefined);
	assert.equal(fs.existsSync(directory), false);
	assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
	buffer.append("end");
	assert.equal(buffer.slice(-1003), "b".repeat(1000) + "end");

});

for (const method of ["mkdtempSync", "openSync"]) test(`${method} failure preserves memory and removes any allocated spool directory`, (t) => {
	const directories = trackExecSpools(t);
	const buffer = bufferFor(t, 3 * Mi);
	buffer.append("prefix");
	t.mock.method(fs, method, () => { throw new Error("spool creation unavailable"); });
	buffer.append("x".repeat(2 * Mi));
	assert.equal(buffer.slice(), "prefix" + "x".repeat(2 * Mi));
	assert.equal(buffer.spool, undefined);
	assert.equal(directories.length, method === "openSync" ? 1 : 0);
	assert.ok(directories.every((directory) => !fs.existsSync(directory)));
});

test("unrecoverable spool reads are explicit and close resources; disposal is idempotent", (t) => {
	const buffer = bufferFor(t, 3 * Mi);
	buffer.append("x".repeat(2 * Mi));
	const { directory, fd } = buffer.spool;
	t.mock.method(fs, "readSync", () => { throw new Error("EIO injected"); });
	assert.throws(() => buffer.slice(-20), /Cannot recover exec output/);
	assert.equal(fs.existsSync(directory), false);
	assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
	assert.doesNotThrow(() => buffer.append("process is still running"));
	assert.throws(() => buffer.slice(), /Cannot recover exec output/);
	buffer.dispose();
	buffer.dispose();
});
