import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const probeUrl = new URL("../evidence/contract-probe.mjs", import.meta.url);
const key = "sd_live_synthetic_" + "q".repeat(120);

test("contract evidence sanitizes response credentials before truncation and persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-contract-probe-"));
	try {
		const script = join(root, "contract-probe.mjs");
		const preload = join(root, "offline.mjs");
		const tracePath = join(root, "trace.json");
		await copyFile(probeUrl, script);
		await writeFile(preload, `
			import { writeFileSync } from "node:fs";
			const calls = [];
			globalThis.fetch = async (url, init) => {
				calls.push({ url: String(url), authorization: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body) });
				return Response.json({
					results: [{ title: "Synthetic", url: "https://example.com", content: "prefix " + process.env.SERPDIVE_API_KEY + " suffix" }],
					answer: process.env.SERPDIVE_API_KEY,
					diagnostic: process.env.SERPDIVE_API_KEY,
				});
			};
			process.on("exit", () => writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(calls)));
		`);
		const child = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script], {
			env: { ...process.env, SERPDIVE_API_KEY: key }, encoding: "utf8",
		});
		assert.equal(child.status, 0, child.stderr);
		const calls = JSON.parse(await readFile(tracePath, "utf8"));
		assert.ok(calls.length > 0);
		assert.ok(calls.every(call => call.url === "https://api.serpdive.com/v1/search"));
		assert.ok(calls.some(call => call.authorization === `Bearer ${key}`));
		assert.ok(calls.every(call => [null, `Bearer ${key}`, "Bearer sd_live_not_a_real_key"].includes(call.authorization)));
		const evidence = await readFile(join(root, "CONTRACT-EVIDENCE.md"), "utf8");
		assert.ok(evidence.includes("[redacted]"), "response credentials must be redacted");
		assert.ok(!evidence.includes(key));
		assert.ok(!evidence.includes(key.slice(0, 50)), "truncated content must not retain a credential prefix");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("contract evidence rejects an unsanitized output before writing and exits nonzero", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-contract-output-"));
	try {
		const target = join(root, "unsafe.md");
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				import { writeContractEvidence } from ${JSON.stringify(probeUrl.href)};
				writeContractEvidence(${JSON.stringify(target)}, ${JSON.stringify(`echoed ${key}`)}, ${JSON.stringify(key)});
			`,
			encoding: "utf8",
		});
		assert.equal(child.status, 1);
		assert.match(child.stderr, /credential.*not written/i);
		assert.ok(!existsSync(target));
		assert.ok(!child.stderr.includes(key));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
