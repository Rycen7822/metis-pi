export declare const MAX_EXEC_YIELD_TIME_MS = 1800000;
export declare const DEFAULT_EXEC_YIELD_TIME_MS = 10000;
export declare const DEFAULT_WRITE_YIELD_TIME_MS = 250;
export declare const DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS = 1800000;
export declare function resolveWorkdir(baseCwd: string, workdir?: string): string;
export declare function resolveShell(shell?: string): string;
export declare function resolveExecution(requestedShell: string | undefined, command: string, extraEnv?: NodeJS.ProcessEnv, baseEnv?: NodeJS.ProcessEnv): {
    shell: string;
    command: string;
    env: NodeJS.ProcessEnv;
};
export declare function normalizeMinNonInteractiveExecYieldTime(value: number | undefined): number;
export declare function normalizeMinEmptyWriteYieldTime(value: number | undefined): number;
export declare function clampExecYieldTime(yieldTimeMs: number | undefined, fallback: number, isInteractive: boolean, minNonInteractiveExecYieldTimeMs: number, maxYieldTimeMs?: number): number;
export declare function clampWriteYieldTime(yieldTimeMs: number | undefined, fallback: number, isEmptyPoll: boolean, minEmptyWriteYieldTimeMs: number, maxEmptyWriteYieldTimeMs: number): number;
