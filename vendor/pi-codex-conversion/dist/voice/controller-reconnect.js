/** Replaces an established realtime call without transferring LAN ownership. */
export function resumeDroppedConversation(options) {
    const { runtime, messages, session, error, callbacks } = options;
    if (callbacks.currentSession() !== session)
        return;
    messages.cancelPendingDelegations();
    const config = runtime.config;
    const ctx = runtime.context;
    if (!config?.voice.autoResumeRealtime || !ctx) {
        markRealtimePeerInactive(runtime, session, error, false);
        callbacks.fail(error);
        return;
    }
    const realtimePeerPlan = runtime.realtimePeerPlan;
    markRealtimePeerInactive(runtime, session, error, true);
    runtime.startAbortController?.abort();
    runtime.startAbortController = undefined;
    const resumeGeneration = ++runtime.startGeneration;
    const wasMuted = callbacks.inputMuted();
    runtime.state = { type: "reconnecting", session };
    callbacks.renderStatus("reconnecting…");
    void (async () => {
        await Promise.allSettled([session.close(), messages.waitForDelegations()]);
        if (runtime.startGeneration !== resumeGeneration ||
            runtime.state.type !== "reconnecting")
            return;
        const resumePromise = callbacks.startReplacement(ctx, config, realtimePeerPlan, wasMuted);
        const replacementGeneration = runtime.startGeneration;
        let resumed;
        try {
            resumed = await resumePromise;
        }
        catch (resumeError) {
            if (runtime.startGeneration === replacementGeneration)
                callbacks.fail(asError(resumeError));
            return;
        }
        if (!resumed) {
            const resumeError = new Error("Codex realtime voice could not resume");
            markRealtimePeerInactive(runtime, session, resumeError, false, realtimePeerPlan);
            if (runtime.state.type === "reconnecting")
                callbacks.fail(resumeError);
            return;
        }
        if (wasMuted && callbacks.currentSession() === resumed)
            callbacks.renderCurrentStatus();
    })();
}
export function markRealtimePeerInactive(runtime, session, error, resuming, plan = runtime.realtimePeerPlan) {
    try {
        plan?.onInactive?.(session, error, resuming);
    }
    catch (ownerError) {
        runtime.context?.ui.notify(`Could not update realtime voice owner: ${asError(ownerError).message}`, "error");
    }
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
