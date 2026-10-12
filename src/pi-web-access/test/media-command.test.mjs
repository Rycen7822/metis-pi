import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const videoUrl = new URL("../video-extract.ts", import.meta.url).href;
const youtubeUrl = new URL("../youtube-extract.ts", import.meta.url).href;
const calls = {
	local_frame: 'video.extractVideoFrame("/synthetic/video.mp4", 2, controller.signal)',
	local_duration: 'video.getLocalVideoDuration("/synthetic/video.mp4", controller.signal)',
	youtube_stream: 'youtube.getYouTubeStreamInfo("dQw4w9WgXcQ", controller.signal)',
	remote_frame: 'youtube.extractYouTubeFrame("dQw4w9WgXcQ", 2, { streamUrl: "https://stream.test/video", duration: 20 }, controller.signal)',
};

for (const [name, expression] of Object.entries(calls)) {
	for (const cancel of [false, true]) {
		test(`${name} lets the event loop progress and ${cancel ? "terminates on caller abort" : "returns command output"}`, { skip: process.platform === "win32" }, async (t) => {
			const root = await mkdtemp(join(tmpdir(), "pi-media-command-"));
			t.after(() => rm(root, { recursive: true, force: true }));
			const bin = join(root, "bin");
			await mkdir(bin);
			for (const command of ["ffmpeg", "ffprobe", "yt-dlp"]) {
				await writeFile(join(bin, command), `#!/usr/bin/env node\n
					const { existsSync, writeFileSync } = require("node:fs");
					process.on("SIGTERM", () => { writeFileSync(process.env.MEDIA_STOPPED, "stopped"); process.exit(0); });
					writeFileSync(process.env.MEDIA_ARGS, JSON.stringify(process.argv.slice(2)));
					writeFileSync(process.env.MEDIA_READY, "ready");
					const timer = setInterval(() => {
						if (!existsSync(process.env.MEDIA_RELEASE)) return;
						clearInterval(timer);
						process.stdout.write(${JSON.stringify(command === "ffmpeg" ? "frame-bytes" : command === "ffprobe" ? "20\n" : "20\nhttps://stream.test/video\n")});
					}, 10);
				`, { mode: 0o755 });
			}
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				input: `
					import assert from "node:assert/strict";
					import { existsSync } from "node:fs";
					import { readFile, writeFile } from "node:fs/promises";
					const video = await import(${JSON.stringify(videoUrl)});
					const youtube = await import(${JSON.stringify(youtubeUrl)});
					const waitFor = async (path) => {
						const until = Date.now() + 5000;
						while (!existsSync(path)) {
							assert.ok(Date.now() < until, "missing command gate " + path);
							await new Promise(resolve => setTimeout(resolve, 10));
						}
					};
					const controller = new AbortController();
					let complete = false;
					const pending = (${expression}).then(result => { complete = true; return result; });
					await waitFor(process.env.MEDIA_READY);
					assert.equal(complete, false, "command must still be pending while parent timers run");
					if (${cancel}) controller.abort();
					else await writeFile(process.env.MEDIA_RELEASE, "release");
					const result = await pending;
					if (${cancel}) {
						assert.equal(result.error, "Aborted");
						await waitFor(process.env.MEDIA_STOPPED);
					} else if (${JSON.stringify(name)} === "local_duration") assert.equal(result, 20);
					else if (${JSON.stringify(name)} === "youtube_stream") assert.deepEqual(result, { duration: 20, streamUrl: "https://stream.test/video" });
					else assert.deepEqual(result, { data: Buffer.from("frame-bytes").toString("base64"), mimeType: "image/jpeg" });
					const args = JSON.parse(await readFile(process.env.MEDIA_ARGS, "utf8"));
					if (${JSON.stringify(name)}.endsWith("frame")) assert.deepEqual(args.slice(0, 4), ["-ss", "2", "-i", ${JSON.stringify(name === "local_frame" ? "/synthetic/video.mp4" : "https://stream.test/video")}]);
				`,
				encoding: "utf8", timeout: 20_000,
				env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, PATH: `${bin}${delimiter}${process.env.PATH || ""}`, MEDIA_READY: join(root, "ready"), MEDIA_RELEASE: join(root, "release"), MEDIA_STOPPED: join(root, "stopped"), MEDIA_ARGS: join(root, "args") },
			});
			assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
		});
	}
}

for (const [kind, timestamp, frames, expected] of [
	["local", "1-11", 3, [1, 6, 11]],
	["local", undefined, 3, [0, 10, 20]],
	["youtube", "1-11", 3, [1, 6, 11]],
]) {
	test(`${kind} frame sampling keeps timestamp order and source-specific duration lookup`, { skip: process.platform === "win32" }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-media-planning-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const bin = join(root, "bin");
		await mkdir(bin);
		const local = join(root, "fixture.mp4");
		await writeFile(local, "synthetic");
		const log = join(root, "commands.jsonl");
		for (const command of ["ffmpeg", "ffprobe", "yt-dlp"]) {
			await writeFile(join(bin, command), `#!/usr/bin/env node\n
				const { appendFileSync } = require("node:fs");
				appendFileSync(process.env.MEDIA_LOG, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }) + "\\n");
				process.stdout.write(${JSON.stringify(command === "ffmpeg" ? "frame" : command === "ffprobe" ? "20\n" : "20\nhttps://stream.test/video\n")});
			`, { mode: 0o755 });
		}
		const moduleUrl = new URL("../extract.ts", import.meta.url).href;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { extractContent } = await import(${JSON.stringify(moduleUrl)});
				const result = await extractContent(${JSON.stringify(kind === "local" ? local : "https://www.youtube.com/watch?v=dQw4w9WgXcQ")}, undefined, { timestamp: ${JSON.stringify(timestamp)}, frames: ${frames}, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
				console.log(JSON.stringify(result));
			`,
			encoding: "utf8", timeout: 15_000,
			env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, PATH: `${bin}${delimiter}${process.env.PATH || ""}`, MEDIA_LOG: log },
		});
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout);
		assert.equal(result.error, null);
		assert.deepEqual(result.frames.map(frame => frame.timestamp), expected.map(t => `0:${String(t).padStart(2, "0")}`));
		const trace = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		assert.deepEqual(trace.filter(call => call.command === "ffmpeg").map(call => Number(call.args[1])).sort((a, b) => a - b), expected);
		assert.equal(trace.filter(call => call.command === "ffprobe").length, kind === "local" && !timestamp ? 1 : 0);
		assert.equal(trace.filter(call => call.command === "yt-dlp").length, kind === "youtube" ? 1 : 0);
	});
}
