export interface CodexCacheEnvironment {
    diagnostics?: "off" | "status" | "status-and-log" | undefined;
    logName?: string | undefined;
    warnings: string[];
}
export declare function readCodexCacheEnvironment(env?: NodeJS.ProcessEnv): CodexCacheEnvironment;
