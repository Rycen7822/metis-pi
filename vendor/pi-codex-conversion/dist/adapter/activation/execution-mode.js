// Retained only so old session entries remain display-only during replay.
export const EXECUTION_MODE_SESSION_ENTRY = "pi-codex-conversion-execution-mode";
export function normalizeExecutionMode(value) {
    return value === "normal" || value === "code" || value === "notebook"
        ? value
        : undefined;
}
