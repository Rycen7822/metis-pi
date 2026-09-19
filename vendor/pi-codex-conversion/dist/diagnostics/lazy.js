export function createLazyCodexDiagnostics() {
    let active;
    let stopInFlight;
    let generation = 0;
    const stopActive = () => {
        const previous = active;
        active = undefined;
        if (!previous)
            return stopInFlight ?? Promise.resolve();
        const current = (stopInFlight ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => previous.runtime.shutdown());
        stopInFlight = current;
        void current.finally(() => {
            if (stopInFlight === current)
                stopInFlight = undefined;
        }).catch(() => undefined);
        return current;
    };
    const stopForReconfigure = async (ctx) => {
        try {
            await stopActive();
        }
        catch (error) {
            try {
                ctx.ui.notify(`Could not close the previous Codex cache log: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
            catch {
                // Diagnostics lifecycle failures must not block session replacement.
            }
        }
    };
    return {
        async configure(options) {
            const model = options.ctx.model;
            const key = JSON.stringify([
                options.mode,
                options.ctx.sessionManager.getSessionId(),
                model?.provider,
                model?.id,
                model?.api,
                model?.baseUrl,
                options.logName,
            ]);
            if (active?.key === key && options.active)
                return;
            const currentGeneration = ++generation;
            const mode = options.mode;
            if (mode === "off" || !options.active) {
                await stopForReconfigure(options.ctx);
                return;
            }
            const module = await import("./runtime.js");
            if (generation !== currentGeneration)
                return;
            await stopForReconfigure(options.ctx);
            if (generation !== currentGeneration)
                return;
            const next = await module.createCodexDiagnosticsRuntime({ ...options, mode });
            if (generation !== currentGeneration) {
                await next.shutdown();
                return;
            }
            let sinkFailed = false;
            const sink = (event) => {
                if (sinkFailed || generation !== currentGeneration || active?.runtime !== next)
                    return;
                try {
                    next.record(event);
                }
                catch (error) {
                    sinkFailed = true;
                    try {
                        options.ctx.ui.notify(`Codex cache diagnostics stopped: ${error instanceof Error ? error.message : String(error)}`, "warning");
                    }
                    catch {
                        // Diagnostics must never affect provider execution.
                    }
                }
            };
            active = { key, runtime: next, sink };
        },
        sink() {
            return active?.sink;
        },
        async shutdown() {
            generation++;
            await stopActive();
        },
    };
}
