import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const browserSrc = readFileSync(new URL("../curator-browser.ts", import.meta.url), "utf8");
const commandSrc = readFileSync(new URL("../tool-commands.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("web_search curator auto-open failures keep the curator alive with a manual URL", () => {
	assert.match(indexSrc, /browserOpenError\?: string;/);
	assert.match(indexSrc, /phase: "curator-fallback"/);
	assert.match(indexSrc, /Search curator is running, but the browser did not open automatically\./);
	assert.match(indexSrc, /Open manually: \$\{handle\.url\}/);
	assert.match(indexSrc, /pc\.browserOpenError = message;/);
	assert.doesNotMatch(indexSrc, /Failed to open curator UI: \$\{message\}`\);\n\t\t\tif \(pendingCurates\.get\(callId\) === pc \|\| \(handle && activeCurators\.get\(callId\) === handle\)\) \{\n\t\t\t\tcloseCurator\(callId\);/);
});

test("curator add-search receives the active extension context", () => {
	assert.match(indexSrc, /openCuratorBrowser\(callId: string, pc: PendingCurate, ctx: ExtensionContext,/);
	assert.match(indexSrc, /openCuratorBrowser\(callId, pc, ctx, false\)/);
	assert.match(indexSrc, /extensionContext: ctx,/);
});

test("cancel diagnostics include curator URL and browser-open error", () => {
	assert.match(indexSrc, /curatorUrl\?: string;/);
	assert.match(indexSrc, /browserOpenError\?: string;/);
	assert.match(indexSrc, /curator: \$\{partial\.curatorUrl\}/);
	assert.match(indexSrc, /browser open error: \$\{partial\.browserOpenError\}/);
});

test("manual websearch command reports browser-open fallback without closing curator", () => {
	assert.match(commandSrc, /let browserOpenError: string \| null = null;/);
	assert.match(commandSrc, /ctx\.ui\.notify\(`Search curator is running, but the browser did not open automatically\. Open manually: \$\{handle\.url\}`/);
	assert.match(commandSrc, /if \(queries\.length > 0\) \{/);
});

test("remote curator mode prints the manual URL unless auto-open is explicit", () => {
	assert.match(browserSrc, /function shouldAutoOpenCuratorBrowser\(/);
	assert.match(browserSrc, /if \(resolveCuratorNetworkConfig\(\)\.enabled && config\.autoOpenBrowser !== true\) return false;/);
	assert.ok(indexSrc.includes('sendCuratorFallbackUpdate("Search curator is running. Open the curator URL manually.")'));
	assert.ok(commandSrc.includes('ctx.ui.notify(`Search curator is running. Open manually: ${handle.url}`, "info")'));
});

test("Linux curator browser launch detaches xdg-open but keeps immediate failures", () => {
	assert.match(browserSrc, /spawn\("xdg-open", \[url\], \{ detached: true, stdio: "ignore" \}\)/);
	assert.match(browserSrc, /child\.once\("error", \(err\) => \{/);
	assert.match(browserSrc, /child\.once\("exit", \(code\) => \{/);
	assert.match(browserSrc, /setTimeout\(resolve, 100\)/);
	assert.match(browserSrc, /child\.unref\(\);/);
});

test("README documents manual browser fallback", () => {
	assert.match(readmeSrc, /Docker, WSL, SSH, or headless environments/);
	assert.match(readmeSrc, /Copy it into a browser that can reach the Pi host/);
	assert.match(readmeSrc, /Remote curator sessions print the URL instead of trying to open a browser by default/);
});
