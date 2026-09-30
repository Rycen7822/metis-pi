const UPSTREAM_HOST_RELEASE = "rust-v0.145.0";
const METIS_HOST_RELEASE = "code-mode-host-rust-v0.145.0-metis.3";

interface CodeModeHostAsset {
	name: string;
	sha256: string;
	release: string;
	repository: string;
}

const METIS_LINUX_X64: CodeModeHostAsset = {
	name: "codex-code-mode-host-x86_64-unknown-linux-gnu.tar.gz",
	sha256: "311f99645dda093d6019305ca032f3c9351ea0a9bd89657e0badfcfccd1f4d70",
	release: METIS_HOST_RELEASE,
	repository: "Rycen7822/metis-pi",
};

export const HOST_ASSETS = {
	"darwin-arm64": [
		"codex-code-mode-host-aarch64-apple-darwin.tar.gz",
		"75f9306834aa8913b5c1f91ff72f1f6b9441e5a92cd5d64b8e605cf54668460c",
	],
	"darwin-x64": [
		"codex-code-mode-host-x86_64-apple-darwin.tar.gz",
		"2628a7925ff13704126693a2d964fb6d9433a70f5b10c7a966dad3629b55a939",
	],
	"linux-arm64": [
		"codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
		"22b5862c7206bc944f59402dbab4b4169e381ae8a68f0144a9ba7b61bcf3dd39",
	],
	"linux-x64": [
		"codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
		"ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e",
	],
	"win32-arm64": [
		"codex-code-mode-host-aarch64-pc-windows-msvc.exe",
		"f7b336e7832c44074c66d2952ab25dfe1ebad46d6fde47abb97ef27d1e259f78",
	],
	"win32-x64": [
		"codex-code-mode-host-x86_64-pc-windows-msvc.exe",
		"de58d3bd9fb88c44555de1104d06fba78e207bce7115d92691b42f6b0f87f3b7",
	],
} as const;

export function codeModeHostBinaryName(platform: string): string {
	return platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
}

export function resolveCodeModeHostAsset(platform: string, arch: string, glibcVersion?: string): CodeModeHostAsset {
	const asset = (HOST_ASSETS as Record<string, readonly [string, string]>)[`${platform}-${arch}`];
	if (!asset) throw new Error(`Unsupported code-mode platform: ${platform}-${arch}`);
	if (platform === "linux" && arch === "x64") {
		const version = glibcVersion ?? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
		const match = /^(\d+)\.(\d+)/.exec(version ?? "");
		if (match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 34))) {
			return METIS_LINUX_X64;
		}
	}
	return { name: asset[0], sha256: asset[1], release: UPSTREAM_HOST_RELEASE, repository: "openai/codex" };
}

export function hostAssetUrl(asset: CodeModeHostAsset): string {
	return `https://github.com/${asset.repository}/releases/download/${asset.release}/${asset.name}`;
}
