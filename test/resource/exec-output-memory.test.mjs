import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const Mi = 1024 * 1024;

test("64 Mi characters of unread output do not remain resident on the JS heap", { timeout: 15_000 }, () => {
	const moduleUrl = new URL("../../vendor/pi-codex-conversion/dist/tools/exec/output-buffer.js", import.meta.url).href;
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
			}));
		} finally { buffer.dispose(); }
	`;
	const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 12_000 });
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	const measured = JSON.parse(child.stdout);
	assert.equal(measured.retained, 64 * Mi);
	assert.ok(measured.growth < 8 * Mi, `retained heap growth was ${measured.growth} bytes`);
});
