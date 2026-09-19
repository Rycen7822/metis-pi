export function readCodexCacheEnvironment(env = process.env) {
    const warnings = [];
    const rawDiagnostics = env["PI_CODEX_CACHE_DIAGNOSTICS"]?.trim().toLowerCase();
    const diagnostics = rawDiagnostics === "off" || rawDiagnostics === "status" || rawDiagnostics === "status-and-log"
        ? rawDiagnostics
        : undefined;
    if (rawDiagnostics !== undefined && diagnostics === undefined) {
        warnings.push("PI_CODEX_CACHE_DIAGNOSTICS must be off, status, or status-and-log");
    }
    const rawLogName = env["PI_CODEX_CACHE_LOG_NAME"]?.trim();
    const logName = rawLogName && Buffer.byteLength(rawLogName) <= 80 ? rawLogName : undefined;
    if (rawLogName && !logName)
        warnings.push("PI_CODEX_CACHE_LOG_NAME must be at most 80 bytes");
    return {
        ...(diagnostics !== undefined ? { diagnostics } : {}),
        ...(logName ? { logName } : {}),
        warnings,
    };
}
