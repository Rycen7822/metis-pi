export declare const EXECUTION_MODE_SESSION_ENTRY = "pi-codex-conversion-execution-mode";
export type ExecutionMode = "normal" | "code" | "notebook";
export declare function normalizeExecutionMode(value: unknown): ExecutionMode | undefined;
