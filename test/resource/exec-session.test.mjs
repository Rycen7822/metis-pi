import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import { createExecSessionManager } from "../../src/execution/exec/session-manager.ts";
import { createExecCommandTool } from "../../src/execution/exec/command-tool.ts";
import { captureBatch } from "../../vendor/pi-condense/src/batch-capture.ts";
import { packToolResult } from "../../vendor/pi-condense/src/packing.ts";
import { waitForExitOrInactivity } from "../../src/execution/exec/wait.ts";
import { trackExecSpools } from "../helpers/exec.mjs";

const Mi = 1024 * 1024;
const binary = fileURLToPath(new URL("../../assets/native-tools/exec/linux-x64/exec_bridge", import.meta.url));
const nativeTest = process.platform === "linux" && process.arch === "x64" && fs.existsSync(binary);

test("a failed snapshot rejects and releases its wait callback without declaring the process exited", async () => {
	const session = { exitCode: undefined, outputVersion: 0, listeners: new Set() };
	const result = waitForExitOrInactivity(session, 10_000, 10_000, undefined, () => { throw new Error("snapshot failed"); });
	for (const wake of session.listeners) wake();
	await assert.rejects(result, /snapshot failed/);
	assert.equal(session.listeners.size, 0);
	assert.equal(session.exitCode, undefined);
});

describe("native exec session lifecycle", { skip: !nativeTest }, () => {
	function nativeExec(t, options = {}) {
		const directories = trackExecSpools(t);
		const manager = createExecSessionManager({
			bridgeBinaryPath: () => binary,
			minNonInteractiveExecYieldTimeMs: 250,
			minEmptyWriteYieldTimeMs: 250,
			maxEmptyWriteYieldTimeMs: 500,
			...options,
		});
		t.after(() => manager.shutdown());
		const exec = (script, options, signal, onUpdate) =>
			manager.exec(command(script, options), process.cwd(), signal, onUpdate);
		return { manager, directories, exec };
	}

	function command(script, options = {}) {
		const quote = (text) => `'${text.replaceAll("'", `'"'"'`)}'`;
		return { cmd: `${quote(process.execPath)} -e ${quote(script)}`, shell: "/bin/sh", login: false, ...options };
	}

	test("durable capture retains the entire decoded process stream before normalization and ring eviction", { timeout: 15000 }, async (t) => {
		const directory = fs.mkdtempSync(join(tmpdir(), "metis-exec-archive-"));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const { manager, exec } = nativeExec(t, { maxSessionBufferChars: 1024 });
		const expected = "FIRST\r\n" + "x".repeat(100000) + "\u001b[31mLAST\r\n";
		const result = await exec(`process.stdout.write(${JSON.stringify(expected)})`, { archiveDirectory: directory, yield_time_ms: 10_000, max_output_tokens: 64 });
		assert.equal(result.exit_code, 0);
		assert.ok(result.output.length <= 256);
		assert.equal(result.fullOutputComplete, true);
		assert.equal(result.fullOutputAppendOnly, true);
		assert.equal(result.fullOutputBytes, Buffer.byteLength(expected));
		assert.equal(fs.readFileSync(result.fullOutputPath, "utf8"), expected);
		await manager.shutdown();
		assert.equal(fs.readFileSync(result.fullOutputPath, "utf8"), expected, "session disposal does not remove durable output");
	});

	for (const smallerRing of [false, true]) test(`durable capture follows ${smallerRing ? "ring eviction" : "a smaller polling budget"} and completed replay`, { timeout: 15000 }, async (t) => {
		const directory = fs.mkdtempSync(join(tmpdir(), "metis-exec-budget-"));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const { manager, exec } = nativeExec(t, smallerRing ? { maxSessionBufferChars: 1024 } : {});
		const expected = "FIRST\r\n" + "x".repeat(8000) + "LAST";
		let result, sessionId;
		if (smallerRing) {
			result = await exec(`process.stdout.write(${JSON.stringify(expected)})`, { archiveDirectory: directory, yield_time_ms: 10_000 });
			sessionId = 1;
		} else {
			const release = join(directory, "release");
			const first = await exec(`const fs=require('node:fs'); const timer=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(${JSON.stringify(expected)});} },25)`, { archiveDirectory: directory, yield_time_ms: 250 });
			sessionId = first.session_id;
			assert.ok(sessionId);
			fs.writeFileSync(release, "go");
			result = await manager.write({ session_id: sessionId, yield_time_ms: 2000, max_output_tokens: 64 });
		}
		assert.equal(result.exit_code, 0);
		assert.ok(result.output.length <= (smallerRing ? 1024 : 256));
		assert.ok(result.fullOutputPath, "every omitted range must have a durable original");
		assert.equal(fs.readFileSync(result.fullOutputPath, "utf8"), expected);
		const replay = await manager.write({ session_id: sessionId, max_output_tokens: 64 });
		assert.equal(replay.fullOutputPath, result.fullOutputPath, "completed replay must retain a late-created archive");
		await manager.shutdown();
		assert.equal(fs.readFileSync(result.fullOutputPath, "utf8"), expected);
	});

	test("deterministic exec packing requires an observed successful exit", { timeout: 15000 }, async (t) => {
		const directory = fs.mkdtempSync(join(tmpdir(), "metis-exec-status-"));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const { manager } = nativeExec(t);
		const log = Array.from({ length: 100 }, (_, i) => `artifact ${i}: ` + "x".repeat(55)).join("\n");
		for (const status of [7, "running", 0]) {
			fs.writeFileSync(join(directory, "build.cjs"), `process.stdout.write(${JSON.stringify(log)});` + (status === "running" ? "setInterval(()=>{},1000)" : `process.exitCode=${status}`));
			fs.writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { build: "node build.cjs" } }));
			const tool = createExecCommandTool(manager);
			const args = { cmd: "npm run build", workdir: directory, shell: "/bin/sh", login: false, yield_time_ms: status === "running" ? 250 : 10_000 };
			const returned = await tool.execute(`status-${status}`, args, undefined, undefined, { cwd: directory });
			assert.equal(returned.details.exit_code, status === "running" ? undefined : status);
			const batch = captureBatch({ content: [{ type: "toolCall", id: `status-${status}`, name: "exec_command", arguments: args }] }, [{ ...returned, toolCallId: `status-${status}`, timestamp: 1 }], 1, 1);
			const packed = packToolResult(batch.toolCalls[0]);
			if (status === 0) assert.ok(packed, "successful exec still takes the local packing path");
			else assert.equal(packed, undefined, `${status} exec must preserve its diagnostics`);
			if (returned.details.session_id) manager.terminateSession(returned.details.session_id);
		}
		const small = await manager.exec(command("process.stdout.write('small')", { archiveDirectory: directory, yield_time_ms: 10_000 }), directory);
		assert.equal(small.output, "small");
		assert.equal(small.fullOutputPath, undefined, "untruncated small results remain inline");
	});

	const text = "first\n" + "x".repeat(2 * Mi) + "🙂last\n";
	for (const scenario of [
		{ name: "full output with a separate 64 Ki replay", options: {}, delivered: text,
			replayTokens: Mi, replayed: "x".repeat(64 * 1024 - 7) + "🙂last\n" },
		{ name: "configured retention and delivery truncation", options: { maxSessionBufferChars: Mi + 20 },
			delivered: "x".repeat(Mi + 13) + "🙂last\n", replayTokens: 80, replayed: "x".repeat(313) + "🙂last\n" },
	]) test(`exit observation: ${scenario.name}`, { timeout: 15_000 }, async (t) => {
		const { manager, directories, exec } = nativeExec(t, scenario.options);
		const result = await exec(`process.stdout.write("first\\n" + "x".repeat(${2 * Mi}) + "🙂last\\n")`, {
			yield_time_ms: 10_000, max_output_tokens: Mi,
		});
		assert.equal(result.exit_code, 0);
		assert.equal(result.session_id, undefined);
		assert.equal(result.output, scenario.delivered);
		assert.ok(directories.length > 0);
		assert.ok(directories.every((path) => !fs.existsSync(path)), "draining exit output removes spools immediately");
		assert.equal(manager.hasSession(1), false);
		const replay = await manager.write({ session_id: 1, max_output_tokens: scenario.replayTokens });
		assert.equal(replay.output, scenario.replayed);
		assert.equal(replay.original_token_count, Math.ceil(text.length / 4));
		assert.equal(result.original_token_count, replay.original_token_count);
		await assert.rejects(manager.write({ session_id: 1, chars: "no" }), /already exited/);
	});

	for (const readFails of [false, true]) test(`background exit ${readFails ? "read failure retains the failed session" : "drains unread output after a cancelled live poll"}`, { timeout: 15_000 }, async (t) => {
		const { manager, directories, exec } = nativeExec(t, { maxEmptyWriteYieldTimeMs: 5000 });
		const exited = new Promise((resolve) => manager.onSessionExit(resolve));
		const running = await exec(`process.stdout.write("start\\n"); setTimeout(() => process.stdout.write("y".repeat(${2 * Mi}) + "end\\n"), 500); setTimeout(() => {}, 1400)`, {
			yield_time_ms: 250, max_output_tokens: Mi,
		});
		assert.equal(running.output, "start\n");
		assert.equal(typeof running.session_id, "number");
		if (!readFails) {
			const controller = new AbortController();
			await assert.rejects(manager.write({ session_id: running.session_id, yield_time_ms: 5000 }, controller.signal, () => {
				if (directories.length) controller.abort();
			}), /write_stdin aborted|exec_command aborted/);
			assert.equal(manager.listSessions().length, 1, "cancelling the wait leaves the actual process running");
			assert.ok(directories.some((path) => fs.existsSync(path)));
		}
		await exited;
		assert.equal(manager.hasSession(running.session_id), true);
		assert.equal(manager.listSessions().length, 0);
		assert.ok(directories.some((path) => fs.existsSync(path)), "background exit keeps unread output");
		const poll = () => manager.write({ session_id: running.session_id, max_output_tokens: Mi });
		if (readFails) {
			const read = t.mock.method(fs, "readSync", () => { throw new Error("read EIO injected"); });
			await assert.rejects(poll(), /Cannot recover exec output/);
			read.mock.restore();
			await assert.rejects(poll(), /Cannot recover exec output/, "failure never publishes successful replay");
		} else {
			const done = await poll();
			assert.equal(done.output, "y".repeat(2 * Mi) + "end\n");
			assert.equal(done.exit_code, 0);
		}
		assert.equal(manager.hasSession(running.session_id), readFails);
		assert.ok(directories.every((path) => !fs.existsSync(path)));
	});

	test("a failed exit disposal removes the session without publishing completed replay", { timeout: 15_000 }, async (t) => {
		const { manager, directories, exec } = nativeExec(t);
		const remove = fs.rmSync;
		let failed = false;
		t.mock.method(fs, "rmSync", (path, options) => {
			if (!failed && directories.includes(path)) { failed = true; throw new Error("cleanup EIO injected"); }
			return remove(path, options);
		});
		t.after(() => { for (const path of directories) remove(path, { recursive: true, force: true }); });
		await assert.rejects(exec(`process.stdout.write("x".repeat(${2 * Mi}))`, {
			yield_time_ms: 10_000,
		}), /cleanup EIO injected/);
		assert.equal(failed, true);
		assert.equal(manager.hasSession(1), false);
		await assert.rejects(manager.write({ session_id: 1 }), /Unknown process id 1/);
	});

	test("exec cancellation and shutdown release large output spools", { timeout: 15_000 }, async (t) => {
		const { manager, directories, exec } = nativeExec(t);
		const controller = new AbortController();
		await assert.rejects(exec(`process.stdout.write("a".repeat(${2 * Mi})); setInterval(() => {}, 1000)`, {
			yield_time_ms: 10_000,
		}, controller.signal, () => {
			if (directories.length) controller.abort(new Error("cancel test"));
		}), /cancel test/);
		assert.equal(manager.hasSession(1), false);
		assert.ok(directories.length > 0);
		assert.ok(directories.every((path) => !fs.existsSync(path)));
		const running = await exec(`process.stdout.write("b".repeat(${2 * Mi})); setInterval(() => {}, 1000)`, { yield_time_ms: 250 });
		assert.equal(typeof running.session_id, "number");
		assert.ok(directories.some((path) => fs.existsSync(path)));
		await manager.shutdown();
		await manager.shutdown();
		assert.ok(directories.every((path) => !fs.existsSync(path)));
		assert.equal(manager.hasSession(running.session_id), false);
		await assert.rejects(manager.write({ session_id: running.session_id }), /shut down/);
	});

	test("incremental byte decoding and TTY stdin continuation survive the buffer change", { timeout: 15_000 }, async (t) => {
		const { manager, exec } = nativeExec(t);
		const script = `process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x99, 0x82])), 50)`;
		const decoded = await exec(script, { yield_time_ms: 10_000 });
		assert.equal(decoded.output, "🙂");
		const waiting = await manager.exec({ cmd: "read line; printf 'reply:%s\\n' \"$line\"", shell: "/bin/sh", login: false, tty: true, yield_time_ms: 250 }, process.cwd());
		assert.equal(typeof waiting.session_id, "number");
		const done = await manager.write({ session_id: waiting.session_id, chars: "hello\n", yield_time_ms: 1000 });
		assert.match(done.output, /reply:hello/);
		assert.equal(done.exit_code, 0);
	});

	test("one failed spool removal does not prevent other sessions from releasing resources", { timeout: 15_000 }, async (t) => {
		const directories = trackExecSpools(t);
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
});
