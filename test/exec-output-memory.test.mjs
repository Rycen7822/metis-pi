import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ExecOutputBuffer } from "../vendor/pi-codex-conversion/src/tools/exec/output-buffer.ts";
import { consumeOutput, peekOutputSince, peekUnconsumedOutput, truncateOutput, truncateToTail } from "../vendor/pi-codex-conversion/src/tools/exec/output.ts";
import { createExecSessionManager } from "../vendor/pi-codex-conversion/src/tools/exec/session-manager.ts";
import { waitForExitOrInactivity } from "../vendor/pi-codex-conversion/src/tools/exec/wait.ts";

const Mi = 1024 * 1024;
const binary = fileURLToPath(new URL("../vendor/pi-codex-conversion/src/tools/exec/bin/linux-x64/exec_bridge", import.meta.url));
const nativeTest = process.platform === "linux" && process.arch === "x64" && fs.existsSync(binary);

function bufferFor(t, maxChars) {
	const buffer = new ExecOutputBuffer(maxChars);
	t.after(() => buffer.dispose());
	return buffer;
}

function trackSpools(t) {
	const directories = [];
	const mkdtemp = fs.mkdtempSync;
	t.mock.method(fs, "mkdtempSync", (...args) => {
		const directory = mkdtemp(...args);
		if (String(args[0]).includes("pi-exec-output-")) directories.push(directory);
		return directory;
	});
	return directories;
}

function managerFor(t, options = {}) {
	const manager = createExecSessionManager({
		bridgeBinaryPath: () => binary,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
		maxEmptyWriteYieldTimeMs: 500,
		...options,
	});
	t.after(() => manager.shutdown());
	return manager;
}

function command(script, options = {}) {
	const quote = (text) => `'${text.replaceAll("'", `'"'"'`)}'`;
	return { cmd: `${quote(process.execPath)} -e ${quote(script)}`, shell: "/bin/sh", login: false, ...options };
}

test("resident and spooled buffers preserve the old character budget, ordering and surrogate boundaries", (t) => {
	for (const cap of [1024, Mi + 37]) {
		const buffer = bufferFor(t, cap);
		let reference = "";
		let startOffset = 0;
		for (const text of ["first\n", "a".repeat(cap - 9), "🙂", "B".repeat(19), "💡".repeat(cap), "last\n"]) {
			const bounded = truncateToTail(reference + text, cap);
			reference = bounded.output;
			startOffset += bounded.removed;
			buffer.append(text);
			assert.equal(buffer.slice(), reference);
			assert.equal(buffer.startOffset, startOffset);
			assert.equal(buffer.endOffset, startOffset + reference.length);
			assert.equal(buffer.slice(-301), reference.slice(-301));
			assert.equal(buffer.slice(3, 91), reference.slice(3, 91));
			assert.equal(buffer.slice(3.5, 91.2), reference.slice(3.5, 91.2));
			assert.ok(buffer.memory.length <= Mi, "resident output remains bounded");
			if (buffer.spool) assert.ok(fs.fstatSync(buffer.spool.fd).size <= cap * 2, "disk ring does not grow with lifetime output");
		}
		assert.equal(Boolean(buffer.spool), cap > Mi, "the ordinary TTY budget stays in memory");
	}
});

test("consuming and peeking read only their requested tail, preserve original counts, and do not re-emit consumed output", (t) => {
	const buffer = bufferFor(t, 4 * Mi);
	const text = "prefix\n" + "x".repeat(3 * Mi) + "🙂".repeat(300);
	buffer.append(text);
	const state = { buffer, emittedOffset: 0 };
	const read = fs.readSync;
	let requestedBytes = 0;
	t.mock.method(fs, "readSync", (...args) => {
		requestedBytes += args[3];
		return read(...args);
	});
	assert.deepEqual(peekUnconsumedOutput(state, 65), truncateOutput(text, 65));
	assert.ok(requestedBytes <= (260 + 1) * 2, "the full spool must not be materialized before truncating");
	assert.equal(state.emittedOffset, 0);
	assert.deepEqual(consumeOutput(state, 65), truncateOutput(text, 65));
	assert.deepEqual(consumeOutput(state, 65), { output: "" });
	const baseline = buffer.endOffset;
	buffer.append("later\n");
	assert.deepEqual(peekOutputSince(state, baseline, 65), { output: "later\n", original_token_count: 2 });
	assert.deepEqual(consumeOutput(state, 65), { output: "later\n", original_token_count: 2 });
	assert.equal(buffer.memory, "");
});

test("64 Mi characters of unread output do not remain resident on the JS heap", { timeout: 15_000 }, () => {
	const moduleUrl = new URL("../vendor/pi-codex-conversion/src/tools/exec/output-buffer.ts", import.meta.url).href;
	const script = `
		import { randomBytes } from "node:crypto";
		import { ExecOutputBuffer } from ${JSON.stringify(moduleUrl)};
		const buffer = new ExecOutputBuffer(256 * 1024 * 1024);
		try {
			global.gc();
			const before = process.memoryUsage().heapUsed;
			for (let index = 0; index < 1024; index++) buffer.append(randomBytes(32 * 1024).toString("hex"));
			global.gc();
			process.stdout.write(JSON.stringify({
				growth: process.memoryUsage().heapUsed - before,
				retained: buffer.length,
				resident: buffer.memory.length,
			}));
		} finally { buffer.dispose(); }
	`;
	const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 12_000 });
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	const measured = JSON.parse(child.stdout);
	assert.equal(measured.retained, 64 * Mi);
	assert.equal(measured.resident, 0);
	assert.ok(measured.growth < 8 * Mi, `retained heap growth was ${measured.growth} bytes`);
});

test("truncation at both the retention and delivery boundary reports original unread character counts", (t) => {
	const buffer = bufferFor(t, Mi + 13);
	const text = "a".repeat(2 * Mi) + "🙂" + "z".repeat(255);
	buffer.append(text);
	const state = { buffer, emittedOffset: 0 };
	assert.deepEqual(peekUnconsumedOutput(state, 64), truncateOutput(text, 64));
	assert.equal(peekUnconsumedOutput(state, 64).output, "z".repeat(255));
	assert.deepEqual(consumeOutput(state, Mi), truncateOutput(truncateToTail(text, Mi + 13).output, Mi, text.length));
});

test("spool creation and partial-write errors fall back without losing the retained output", (t) => {
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

	const fallback = bufferFor(t, 3 * Mi);
	t.mock.method(fs, "mkdtempSync", () => { throw new Error("temp volume unavailable"); });
	fallback.append("x".repeat(2 * Mi));
	assert.equal(fallback.slice().length, 2 * Mi);
	assert.equal(fallback.spool, undefined);
});

test("failure while opening a new spool removes its private directory and preserves in-memory output", (t) => {
	const directories = trackSpools(t);
	const buffer = bufferFor(t, 3 * Mi);
	buffer.append("prefix");
	t.mock.method(fs, "openSync", () => { throw new Error("cannot open spool"); });
	buffer.append("x".repeat(2 * Mi));
	assert.equal(buffer.slice(), "prefix" + "x".repeat(2 * Mi));
	assert.equal(directories.length, 1);
	assert.equal(fs.existsSync(directories[0]), false);
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
	buffer.append("x".repeat(2 * Mi));
	assert.equal(buffer.memory, "");
	assert.equal(buffer.spool, undefined);
});

test("a failed snapshot rejects and releases its wait callback without declaring the process exited", async () => {
	const session = { exitCode: undefined, outputVersion: 0, listeners: new Set() };
	const result = waitForExitOrInactivity(session, 10_000, 10_000, undefined, () => { throw new Error("snapshot failed"); });
	for (const wake of session.listeners) wake();
	await assert.rejects(result, /snapshot failed/);
	assert.equal(session.listeners.size, 0);
	assert.equal(session.exitCode, undefined);
});

test("native exit-observing exec delivers the full requested output, then retains only a separate 64 Ki replay", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = managerFor(t);
	const text = "first\n" + "x".repeat(2 * Mi) + "🙂last\n";
	const result = await manager.exec(command(`process.stdout.write("first\\n" + "x".repeat(${2 * Mi}) + "🙂last\\n")`, {
		wait_until_exit: true, max_output_tokens: Mi,
	}), process.cwd());
	assert.equal(result.exit_code, 0);
	assert.equal(result.session_id, undefined);
	assert.equal(result.output, text);
	assert.ok(directories.length > 0);
	assert.ok(directories.every((path) => !fs.existsSync(path)), "draining exit output removes spools immediately");
	assert.equal(manager.hasSession(1), false);
	const replay = await manager.write({ session_id: 1, max_output_tokens: Mi });
	assert.equal(replay.output, truncateToTail(text, 64 * 1024).output);
	assert.equal(replay.original_token_count, Math.ceil(text.length / 4));
	await assert.rejects(manager.write({ session_id: 1, chars: "no" }), /already exited/);
});

test("unread background exit output remains spooled until write_stdin observes exit", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = managerFor(t);
	const exited = new Promise((resolve) => manager.onSessionExit(resolve));
	const running = await manager.exec(command(`process.stdout.write("start\\n"); setTimeout(() => process.stdout.write("y".repeat(${2 * Mi}) + "end\\n"), 1000)`, {
		yield_time_ms: 250, max_output_tokens: Mi,
	}), process.cwd());
	assert.equal(running.output, "start\n");
	assert.equal(typeof running.session_id, "number");
	await exited;
	assert.equal(manager.hasSession(running.session_id), true);
	assert.equal(manager.listSessions().length, 0);
	assert.ok(directories.some((path) => fs.existsSync(path)), "unread output is not discarded on background exit");
	const done = await manager.write({ session_id: running.session_id, max_output_tokens: Mi });
	assert.equal(done.output, "y".repeat(2 * Mi) + "end\n");
	assert.equal(done.exit_code, 0);
	assert.equal(manager.hasSession(running.session_id), false);
	assert.ok(directories.every((path) => !fs.existsSync(path)));
});

test("configured retention and delivery truncation remain separate from native completion replay", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const manager = managerFor(t, { maxSessionBufferChars: Mi + 20 });
	const text = "a".repeat(2 * Mi) + "ending\n";
	const result = await manager.exec(command(`process.stdout.write("a".repeat(${2 * Mi}) + "ending\\n")`, {
		wait_until_exit: true, max_output_tokens: Mi,
	}), process.cwd());
	assert.equal(result.output, truncateToTail(text, Mi + 20).output);
	assert.equal(result.original_token_count, Math.ceil(text.length / 4));
	const replay = await manager.write({ session_id: 1, max_output_tokens: 80 });
	assert.equal(replay.output, text.slice(-320));
	assert.equal(replay.original_token_count, result.original_token_count);
});

test("a failed exit read cannot delete the session or publish successful replay", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = managerFor(t);
	const exited = new Promise((resolve) => manager.onSessionExit(resolve));
	const running = await manager.exec(command(`process.stdout.write("start\\n"); setTimeout(() => process.stdout.write("x".repeat(${2 * Mi})), 1000)`, {
		yield_time_ms: 250,
	}), process.cwd());
	assert.equal(typeof running.session_id, "number");
	await exited;
	const read = t.mock.method(fs, "readSync", () => { throw new Error("read EIO injected"); });
	await assert.rejects(manager.write({ session_id: running.session_id }), /Cannot recover exec output/);
	read.mock.restore();
	assert.equal(manager.hasSession(running.session_id), true);
	await assert.rejects(manager.write({ session_id: running.session_id }), /Cannot recover exec output/);
	assert.ok(directories.length > 0);
	assert.ok(directories.every((path) => !fs.existsSync(path)));
});

test("a failed exit disposal removes the session without publishing completed replay", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = managerFor(t);
	const remove = fs.rmSync;
	let failed = false;
	t.mock.method(fs, "rmSync", (path, options) => {
		if (!failed && directories.includes(path)) { failed = true; throw new Error("cleanup EIO injected"); }
		return remove(path, options);
	});
	t.after(() => { for (const path of directories) remove(path, { recursive: true, force: true }); });
	await assert.rejects(manager.exec(command(`process.stdout.write("x".repeat(${2 * Mi}))`, {
		wait_until_exit: true,
	}), process.cwd()), /cleanup EIO injected/);
	assert.equal(failed, true);
	assert.equal(manager.hasSession(1), false);
	await assert.rejects(manager.write({ session_id: 1 }), /Unknown process id 1/);
});

test("exec cancellation and shutdown release large output spools", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = managerFor(t);
	const controller = new AbortController();
	await assert.rejects(manager.exec(command(`process.stdout.write("a".repeat(${2 * Mi})); setInterval(() => {}, 1000)`, {
		wait_until_exit: true,
	}), process.cwd(), controller.signal, () => {
		if (directories.length) controller.abort(new Error("cancel test"));
	}), /cancel test/);
	assert.equal(manager.hasSession(1), false);
	assert.ok(directories.length > 0);
	assert.ok(directories.every((path) => !fs.existsSync(path)));
	const running = await manager.exec(command(`process.stdout.write("b".repeat(${2 * Mi})); setInterval(() => {}, 1000)`, { yield_time_ms: 250 }), process.cwd());
	assert.equal(typeof running.session_id, "number");
	assert.ok(directories.some((path) => fs.existsSync(path)));
	await manager.shutdown();
	await manager.shutdown();
	assert.ok(directories.every((path) => !fs.existsSync(path)));
	assert.equal(manager.hasSession(running.session_id), false);
	await assert.rejects(manager.write({ session_id: running.session_id }), /shut down/);
});

test("cancelling a write_stdin wait leaves the process and unread spool available for the next poll", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = managerFor(t, { maxEmptyWriteYieldTimeMs: 5000 });
	const running = await manager.exec(command(`process.stdout.write("start\\n"); setTimeout(() => process.stdout.write("y".repeat(${2 * Mi})), 500); setTimeout(() => {}, 1400)`, { yield_time_ms: 250 }), process.cwd());
	const controller = new AbortController();
	await assert.rejects(manager.write({ session_id: running.session_id, yield_time_ms: 5000 }, controller.signal, () => {
		if (directories.length) controller.abort();
	}), /write_stdin aborted|exec_command aborted/);
	assert.equal(manager.hasSession(running.session_id), true);
	assert.ok(directories.some((path) => fs.existsSync(path)));
	let output = "";
	let result;
	do {
		result = await manager.write({ session_id: running.session_id, yield_time_ms: 500, max_output_tokens: Mi });
		output += result.output;
	} while (result.session_id !== undefined);
	assert.equal(result.exit_code, 0);
	assert.equal(output, "y".repeat(2 * Mi));
	assert.ok(directories.every((path) => !fs.existsSync(path)));
});

test("incremental byte decoding and TTY stdin continuation survive the buffer change", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const manager = managerFor(t);
	const script = `process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x99, 0x82])), 50)`;
	const decoded = await manager.exec(command(script, { wait_until_exit: true }), process.cwd());
	assert.equal(decoded.output, "🙂");
	const waiting = await manager.exec({ cmd: "read line; printf 'reply:%s\\n' \"$line\"", shell: "/bin/sh", login: false, tty: true, yield_time_ms: 250 }, process.cwd());
	assert.equal(typeof waiting.session_id, "number");
	const done = await manager.write({ session_id: waiting.session_id, chars: "hello\n", yield_time_ms: 1000 });
	assert.match(done.output, /reply:hello/);
	assert.equal(done.exit_code, 0);
});

test("one failed spool removal does not prevent other sessions from releasing resources", { skip: !nativeTest, timeout: 15_000 }, async (t) => {
	const directories = trackSpools(t);
	const manager = createExecSessionManager({ bridgeBinaryPath: () => binary, minNonInteractiveExecYieldTimeMs: 250 });
	t.after(async () => {
		await manager.shutdown().catch(() => {});
		for (const path of directories) fs.rmSync(path, { recursive: true, force: true });
	});
	const sessions = [];
	for (let i = 0; i < 2; i++) {
		sessions.push(await manager.exec(command(`process.stdout.write("x".repeat(${2 * Mi})); setInterval(() => {}, 1000)`, { yield_time_ms: 250 }), process.cwd()));
	}
	assert.equal(directories.length, 2);
	const remove = fs.rmSync;
	let failed = false;
	t.mock.method(fs, "rmSync", (path, options) => {
		if (!failed && path === directories[0]) { failed = true; throw new Error("cleanup EIO injected"); }
		return remove(path, options);
	});
	await assert.rejects(manager.shutdown(), (error) => error instanceof AggregateError
		&& error.errors.some((failure) => /cleanup EIO injected/.test(failure.message)));
	assert.equal(fs.existsSync(directories[1]), false);
	for (const result of sessions) assert.equal(manager.hasSession(result.session_id), false);
});
