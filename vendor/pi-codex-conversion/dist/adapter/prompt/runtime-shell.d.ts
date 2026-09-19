import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const CODEX_FALLBACK_SHELL = "/bin/bash";
export declare function isFishShell(shell: string | undefined): boolean;
export declare function getCodexRuntimeShell(shell: string | undefined): string;
export declare function getCodexShellArgs(shell: string, command: string, login: boolean): string[];
export declare function getDefaultCodexRuntimeShell(configuredShellPath?: string): string;
export declare function getPiCodexRuntimeShell(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, agentDir?: string): string;
export declare function getPiConfiguredShellPath(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, agentDir?: string): string | undefined;
