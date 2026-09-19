import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CacheDiagnosticsMode } from "../adapter/activation/config.ts";
import type { CodexDiagnosticsSink } from "../providers/openai-codex/types.ts";
export interface LazyCodexDiagnostics {
    configure(options: {
        mode: CacheDiagnosticsMode;
        active: boolean;
        ctx: ExtensionContext;
        agentDir: string;
        logName?: string | undefined;
        announceLog?: boolean | undefined;
    }): Promise<void>;
    sink(): CodexDiagnosticsSink | undefined;
    shutdown(): Promise<void>;
}
export declare function createLazyCodexDiagnostics(): LazyCodexDiagnostics;
