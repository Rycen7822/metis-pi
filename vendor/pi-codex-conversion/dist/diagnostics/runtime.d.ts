import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CacheDiagnosticsMode } from "../adapter/activation/config.ts";
import type { CodexDiagnosticsEvent } from "../providers/openai-codex/types.ts";
export declare const CACHE_MISS_HOLD_MS = 3000;
export interface CodexDiagnosticsRuntime {
    record(event: CodexDiagnosticsEvent): void;
    shutdown(): Promise<void>;
}
export declare function createCodexDiagnosticsRuntime(options: {
    mode: Exclude<CacheDiagnosticsMode, "off">;
    ctx: ExtensionContext;
    agentDir: string;
    logName?: string | undefined;
    announceLog?: boolean | undefined;
    missHoldMs?: number | undefined;
}): Promise<CodexDiagnosticsRuntime>;
