// Pi browser/window adaptation shared by the tool and command hosts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadWebAccessConfig } from "./utils.ts";
import { resolveCuratorNetworkConfig } from "./curator-network.ts";

export function shouldAutoOpenCuratorBrowser(config = loadWebAccessConfig()): boolean {
	if (config.autoOpenBrowser === false) return false;
	if (resolveCuratorNetworkConfig().enabled && config.autoOpenBrowser !== true) return false;
	return true;
}

async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
	const plat = platform();
	if (plat !== "darwin" && plat !== "win32") {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
			const timer = setTimeout(resolve, 100);
			child.once("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`Failed to open browser (exit code ${code ?? "unknown"})`));
			});
			child.unref();
		});
		return;
	}
	const result = plat === "darwin"
		? await pi.exec("open", [url])
		: await pi.exec("cmd", ["/c", "start", "", url]);
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
	}
}

export interface GlimpseWindow {
	on(event: "closed", handler: () => void): void;
	on(event: "message", handler: (data: unknown) => void): void;
	on(event: "ready", handler: (info: { screen?: { visibleHeight?: number } }) => void): void;
	close(): void;
	_write(obj: Record<string, unknown>): void;
}

let glimpseOpen: ((html: string, opts: Record<string, unknown>) => GlimpseWindow) | null | undefined;

function findGlimpseMjs(): string | null {
	try {
		const req = createRequire(import.meta.url);
		return req.resolve("glimpseui");
	} catch {
		// Optional dependency.
	}
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
		const entry = join(globalRoot, "glimpseui", "src", "glimpse.mjs");
		if (existsSync(entry)) return entry;
	} catch {
		// npm may be unavailable.
	}
	return null;
}

async function getGlimpseOpen() {
	if (glimpseOpen !== undefined) return glimpseOpen;
	const resolved = findGlimpseMjs();
	if (resolved) {
		try {
			glimpseOpen = (await import(resolved)).open;
			return glimpseOpen;
		} catch {}
	}
	glimpseOpen = null;
	return glimpseOpen;
}

function openInGlimpse(
	open: (html: string, opts: Record<string, unknown>) => GlimpseWindow,
	url: string,
	title: string,
): GlimpseWindow {
	const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
	const win = open(shellHTML, {
		width: 800,
		height: 900,
		title,
	});

	let maxHeight = 1200;
	win.on("ready", (info) => {
		const visibleHeight = info?.screen?.visibleHeight;
		if (typeof visibleHeight === "number" && visibleHeight > 0) {
			maxHeight = Math.floor(visibleHeight * 0.85);
		}
	});
	win.on("message", (data) => {
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (msg.type !== "resize" || typeof msg.height !== "number") return;
		const clamped = Math.max(400, Math.min(Math.round(msg.height), maxHeight));
		win._write({ type: "resize", width: 800, height: clamped });
	});

	return win;
}

export async function openCuratorBrowserWindow(pi: ExtensionAPI, url: string): Promise<GlimpseWindow | null> {
	const open = platform() === "darwin" ? await getGlimpseOpen() : null;
	if (open) {
		try { return openInGlimpse(open, url, "Search Curator"); }
		catch (error) { console.error(`Failed to open Glimpse curator window: ${error instanceof Error ? error.message : String(error)}`); }
	}
	await openInBrowser(pi, url);
	return null;
}
