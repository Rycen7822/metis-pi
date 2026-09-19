export declare const HOST_RELEASE = "rust-v0.145.0";
export declare const HOST_ASSETS: {
    readonly "darwin-arm64": readonly ["codex-code-mode-host-aarch64-apple-darwin.tar.gz", "75f9306834aa8913b5c1f91ff72f1f6b9441e5a92cd5d64b8e605cf54668460c"];
    readonly "darwin-x64": readonly ["codex-code-mode-host-x86_64-apple-darwin.tar.gz", "2628a7925ff13704126693a2d964fb6d9433a70f5b10c7a966dad3629b55a939"];
    readonly "linux-arm64": readonly ["codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz", "22b5862c7206bc944f59402dbab4b4169e381ae8a68f0144a9ba7b61bcf3dd39"];
    readonly "linux-x64": readonly ["codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz", "ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e"];
    readonly "win32-arm64": readonly ["codex-code-mode-host-aarch64-pc-windows-msvc.exe", "f7b336e7832c44074c66d2952ab25dfe1ebad46d6fde47abb97ef27d1e259f78"];
    readonly "win32-x64": readonly ["codex-code-mode-host-x86_64-pc-windows-msvc.exe", "de58d3bd9fb88c44555de1104d06fba78e207bce7115d92691b42f6b0f87f3b7"];
};
export declare function codeModeHostBinaryName(platform: string): string;
export declare function resolveCodeModeHostAsset(platform: string, arch: string): readonly [string, string];
export declare function hostAssetUrl(assetName: string): string;
