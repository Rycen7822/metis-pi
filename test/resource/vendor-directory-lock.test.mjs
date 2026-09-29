import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireDirectoryLock } from "../../vendor/pi-codex-conversion/src/tools/code-mode/directory-lock.ts";
import { installCodeModeHost } from "../../vendor/pi-codex-conversion/src/tools/code-mode/install-host.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

const options = { waitMs: 150, staleMs: 60, pollMs: 5 };

test("a live owner survives stale timestamps and releases only its own directory", async (t) => {
	const dir = temporaryDirectory(t, "metis-directory-lock-");
	const path = join(dir, "lease");
	const owner = await acquireDirectoryLock(path, options);
	assert.ok(owner);
	const old = new Date(Date.now() - 10_000);
	await utimes(path, old, old);
	for (const name of await readdir(path)) await utimes(join(path, name), old, old);
	await assert.rejects(acquireDirectoryLock(path, { ...options, waitMs: 25 }), /timed out waiting for lock/);
	owner.release();
	assert.equal(existsSync(path), false);
	const replacement = await acquireDirectoryLock(path, options);
	assert.ok(replacement);
	owner.release();
	assert.equal(existsSync(path), true, "the previous owner cannot delete a later lease");
	replacement.release();
});

test("a dead owner is reclaimed while an active child owner blocks contenders", async (t) => {
	const dir = temporaryDirectory(t, "metis-directory-lock-");
	const path = join(dir, "lease");
	await mkdir(path);
	const old = new Date(Date.now() - 10_000);
	await writeFile(join(path, "dead.owner"), "99999999\n0\n");
	await utimes(join(path, "dead.owner"), old, old);
	await utimes(path, old, old);
	const recovered = await acquireDirectoryLock(path, options);
	assert.ok(recovered);
	recovered.release();
	const modulePath = fileURLToPath(new URL("../../vendor/pi-codex-conversion/src/tools/code-mode/directory-lock.ts", import.meta.url));
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { acquireDirectoryLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
		const lock = await acquireDirectoryLock(process.argv[1], ${JSON.stringify(options)});
		process.stdout.write("ready\\n");
		process.stdin.once("data", () => { lock.release(); process.exit(0); });
	`, path], { stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => { child.kill(); });
	await new Promise((resolve, reject) => {
		child.stdout.once("data", (data) => data.toString().includes("ready") ? resolve() : reject(new Error(data.toString())));
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`child exited before locking: ${code}`)));
	});
	await assert.rejects(acquireDirectoryLock(path, { ...options, waitMs: 25 }), /timed out waiting for lock/);
	child.stdin.write("release\n");
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(existsSync(path), false);
});

test("abort, timeout and destination completion leave a contended lock alone", async (t) => {
	const dir = temporaryDirectory(t, "metis-directory-lock-");
	const path = join(dir, "lease");
	const owner = await acquireDirectoryLock(path, options);
	assert.ok(owner);
	const controller = new AbortController();
	const waiting = acquireDirectoryLock(path, { ...options, signal: controller.signal });
	await delay(15);
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	assert.equal(existsSync(path), true);
	assert.equal(await acquireDirectoryLock(path, { ...options, waitMs: 0, stopWaiting: () => true }), undefined);
	await assert.rejects(acquireDirectoryLock(path, { ...options, waitMs: 0 }), /timed out waiting for lock/);
	owner.release();
});

test("code-mode installer releases its lease after download failure", async (t) => {
	const dir = temporaryDirectory(t, "metis-directory-lock-");
	const destination = join(dir, "codex-code-mode-host");
	await assert.rejects(installCodeModeHost({ destination, platform: "linux", arch: "x64", fetch: async () => { throw new Error("offline test"); } }), /failed to download/);
	assert.equal(existsSync(`${destination}.lock`), false);
	assert.equal(existsSync(destination), false);
});
