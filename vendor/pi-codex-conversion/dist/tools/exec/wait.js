export function registerAbortHandler(signal, onAbort) {
    if (!signal)
        return () => { };
    if (signal.aborted) {
        onAbort();
        return () => { };
    }
    const abortListener = () => onAbort();
    signal.addEventListener("abort", abortListener, { once: true });
    return () => signal.removeEventListener("abort", abortListener);
}
export function waitForExitOrInactivity(session, idleTimeMs, maxWaitMs = idleTimeMs, signal, onUpdate) {
    if (session.exitCode !== undefined && session.exitCode !== null)
        return Promise.resolve(0);
    if (signal?.aborted)
        return Promise.resolve(0);
    const startedAt = Date.now();
    const hardLimitMs = Math.max(idleTimeMs, maxWaitMs);
    let updateTimer;
    let idleTimer;
    let hardTimer;
    let lastUpdateAt = 0;
    let outputVersion = session.outputVersion;
    return new Promise((resolvePromise) => {
        let abortCleanup;
        let done = false;
        const cleanup = () => {
            if (idleTimer)
                clearTimeout(idleTimer);
            if (hardTimer)
                clearTimeout(hardTimer);
            if (updateTimer)
                clearInterval(updateTimer);
            abortCleanup?.();
            session.listeners.delete(onWake);
        };
        const finish = () => {
            if (done)
                return;
            done = true;
            cleanup();
            resolvePromise(Date.now() - startedAt);
        };
        const emitUpdate = (force = false) => {
            const now = Date.now();
            if (!force && now - lastUpdateAt < 250)
                return;
            lastUpdateAt = now;
            onUpdate?.(now - startedAt);
        };
        const onWake = () => {
            if (session.exitCode === undefined || session.exitCode === null) {
                if (session.outputVersion !== outputVersion) {
                    outputVersion = session.outputVersion;
                    if (idleTimer)
                        clearTimeout(idleTimer);
                    idleTimer = setTimeout(finish, idleTimeMs);
                }
                emitUpdate();
                return;
            }
            emitUpdate(true);
            finish();
        };
        idleTimer = setTimeout(finish, idleTimeMs);
        hardTimer = setTimeout(finish, hardLimitMs);
        abortCleanup = registerAbortHandler(signal, finish);
        if (onUpdate)
            updateTimer = setInterval(emitUpdate, 250);
        session.listeners.add(onWake);
    });
}
