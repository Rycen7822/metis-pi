import { spawn } from "node:child_process";

export const GITHUB_URL = "https://github.com/Rycen7822/metis-pi";
export const CHANGELOG_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
export const DISCORD_URL = "https://discord.com/channels/1456806362351669492/1482388023994748948";
export const ISSUE_URL = `${GITHUB_URL}/issues/new`;

export function openExternalUrl(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", (error) => {
		console.warn(`[metis-pi] Failed to open ${url}: ${error.message}`);
	});
	child.unref();
}
