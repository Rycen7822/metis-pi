import type { CodexDiagnosticsEvent } from "../providers/openai-codex/types.ts";
export interface CodexDiagnosticsLog {
    path: string;
    record(event: CodexDiagnosticsEvent): void;
    close(): Promise<void>;
}
export declare function codexDiagnosticsLogPath(options: {
    agentDir: string;
    sessionId: string;
    sessionFile?: string | undefined;
    sessionName?: string | undefined;
    logName?: string | undefined;
}): string;
export declare function createCodexDiagnosticsLog(options: {
    sessionId: string;
    sessionFile?: string | undefined;
    sessionName?: string | undefined;
    logName?: string | undefined;
    cwd: string;
    modelProvider?: string | undefined;
    modelId?: string | undefined;
    agentDir: string;
    onError: (error: unknown) => void;
}): Promise<CodexDiagnosticsLog>;
