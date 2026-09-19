const CACHE_STATUS_KEY = "codex-cache";
const CACHE_STATUS_TEXT = "Codex Cache";
export const CACHE_MISS_HOLD_MS = 3_000;
function laneLabel(lane) {
    return lane === "response" ? undefined : lane;
}
function requestTransportLabel(event) {
    if (event.transport === "sse")
        return "SSE full";
    if (event.continuation === "delta")
        return "WS delta";
    return event.continuation ? `WS full (${event.continuation.replaceAll("_", " ")})` : "WS full";
}
function failureLabel(failure) {
    return [
        failure.category.replaceAll("_", " "),
        failure.code,
        failure.status,
    ].filter((value) => value !== undefined).join(" • ");
}
export async function createCodexDiagnosticsRuntime(options) {
    const { ctx } = options;
    let log;
    let logActive = false;
    let logFailureReported = false;
    let holdTimer;
    let holdingMiss = false;
    let latestAfterMiss;
    const latestRequests = new Map();
    const themedStatus = (suffix, warning = false) => {
        const title = ctx.ui.theme.fg("accent", CACHE_STATUS_TEXT);
        const detail = ctx.ui.theme.fg(warning ? "warning" : "dim", ` • ${suffix}`);
        return `${title}${detail}`;
    };
    const show = (status) => ctx.ui.setStatus(CACHE_STATUS_KEY, status);
    const showCurrent = (suffix) => {
        const status = themedStatus(`${suffix}${logActive ? " • log" : ""}`);
        if (holdingMiss)
            latestAfterMiss = status;
        else
            show(status);
    };
    const holdMiss = (suffix) => {
        if (holdTimer)
            clearTimeout(holdTimer);
        holdingMiss = true;
        latestAfterMiss = undefined;
        show(themedStatus(`${suffix}${logActive ? " • log" : ""}`, true));
        holdTimer = setTimeout(() => {
            holdingMiss = false;
            holdTimer = undefined;
            if (latestAfterMiss)
                show(latestAfterMiss);
            latestAfterMiss = undefined;
        }, options.missHoldMs ?? CACHE_MISS_HOLD_MS);
        holdTimer.unref?.();
    };
    const reportLogFailure = (error) => {
        logActive = false;
        if (logFailureReported)
            return;
        logFailureReported = true;
        ctx.ui.notify(`Codex cache logging stopped: ${error instanceof Error ? error.message : String(error)}`, "warning");
    };
    if (options.mode === "status-and-log") {
        try {
            const logger = await import("./logger.js");
            log = await logger.createCodexDiagnosticsLog({
                agentDir: options.agentDir,
                sessionId: ctx.sessionManager.getSessionId(),
                sessionFile: ctx.sessionManager.getSessionFile(),
                sessionName: ctx.sessionManager.getSessionName(),
                logName: options.logName,
                cwd: ctx.cwd,
                modelProvider: ctx.model?.provider,
                modelId: ctx.model?.id,
                onError: reportLogFailure,
            });
            logActive = true;
            if (options.announceLog)
                ctx.ui.notify(`Codex cache log: ${log.path}`, "info");
        }
        catch (error) {
            reportLogFailure(error);
        }
    }
    showCurrent("waiting");
    return {
        record(event) {
            log?.record(event);
            if (event.type === "request") {
                latestRequests.set(event.lane, event);
                showCurrent([laneLabel(event.lane), requestTransportLabel(event)].filter(Boolean).join(" • "));
                return;
            }
            if (event.type === "usage") {
                const totalInput = event.inputTokens + event.cachedInputTokens + event.cacheWriteInputTokens;
                const request = latestRequests.get(event.lane);
                const transport = request
                    ? requestTransportLabel(request)
                    : event.transport === "websocket" ? "WS" : "SSE";
                const prefix = laneLabel(event.lane);
                if (event.cachedInputTokens === 0 && totalInput > 0) {
                    holdMiss([prefix, "MISS", transport].filter(Boolean).join(" • "));
                    return;
                }
                showCurrent([prefix, totalInput > 0 ? "HIT" : "cache unavailable", transport].filter(Boolean).join(" • "));
                return;
            }
            if (event.type === "prewarm-ready") {
                const strategy = event.prewarm.keepaliveStrategy;
                if (strategy === "generated-current" && event.usage) {
                    const totalInput = event.usage.inputTokens + event.usage.cachedInputTokens + event.usage.cacheWriteInputTokens;
                    const suffix = `${strategy} • ${event.usage.cachedInputTokens > 0 ? "HIT" : "MISS"} • WS ${event.socketReused ? "reused" : "new"}`;
                    if (event.usage.cachedInputTokens > 0 || totalInput === 0)
                        showCurrent(suffix);
                    else
                        holdMiss(suffix);
                    return;
                }
                showCurrent(`${strategy ?? event.prewarm.kind} ready • WS ${event.socketReused ? "reused" : "new"}`);
                return;
            }
            if (event.type === "keepalive")
                return;
            if (event.type === "retry") {
                showCurrent(`${laneLabel(event.lane) ? `${laneLabel(event.lane)} • ` : ""}${event.transport === "websocket" ? "WS" : "SSE"} retry ${event.attempt}`);
                return;
            }
            if (event.type === "fallback") {
                showCurrent(`${laneLabel(event.lane) ? `${laneLabel(event.lane)} • ` : ""}WS → SSE`);
                return;
            }
            showCurrent(`${laneLabel(event.lane) ? `${laneLabel(event.lane)} • ` : ""}${event.transport === "websocket" ? "WS" : "SSE"} failed: ${failureLabel(event.failure)}`);
        },
        async shutdown() {
            if (holdTimer)
                clearTimeout(holdTimer);
            const failures = [];
            try {
                ctx.ui.setStatus(CACHE_STATUS_KEY, undefined);
            }
            catch (error) {
                failures.push(error);
            }
            try {
                await log?.close();
            }
            catch (error) {
                failures.push(error);
            }
            if (failures.length === 1)
                throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(failures, "Codex cache diagnostics shutdown failed");
        },
    };
}
