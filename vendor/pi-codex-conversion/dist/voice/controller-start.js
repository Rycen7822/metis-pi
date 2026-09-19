import { resolveCodexVoiceAuth } from "./auth.js";
import { CANCELLED, interruptible } from "./cancellation.js";
import { buildRealtimeInitialItems, } from "./context.js";
import { startControllerConversation, startControllerDictation, } from "./controller-sessions.js";
import { currentVoiceSession, VOICE_STATUS_KEY, } from "./controller-support.js";
export async function prepareControllerRealtimeContext(options) {
    let generatedSummary;
    const initialItems = await buildRealtimeInitialItems({
        ctx: options.ctx,
        config: options.config,
        sourceLeafId: options.sourceLeafId,
        forceSummary: options.forceSummary,
        onSummaryGenerated: (value) => {
            generatedSummary = value;
        },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onSummaryStatus
            ? { onSummaryStatus: options.onSummaryStatus }
            : {}),
    });
    return {
        initialItems,
        ...(generatedSummary ? { summary: generatedSummary } : {}),
    };
}
export async function startControllerMode(options) {
    const { runtime, signal } = options;
    if (signal?.aborted)
        return;
    const realtimePrompt = options.mode === "realtime"
        ? options.prepareRealtimePrompt(options.ctx)
        : undefined;
    if (options.mode === "realtime" && realtimePrompt === undefined)
        return;
    if (!options.resume) {
        if (runtime.state.type === "dictation")
            await options.finishCurrentDictation();
        else
            await options.stopCurrent();
    }
    else if (runtime.state.type !== "reconnecting")
        return;
    if (signal?.aborted)
        return;
    const startAbortController = new AbortController();
    runtime.startAbortController = startAbortController;
    const startSignal = signal
        ? AbortSignal.any([signal, startAbortController.signal])
        : startAbortController.signal;
    const startGeneration = ++runtime.startGeneration;
    runtime.context = options.ctx;
    runtime.config = options.config;
    runtime.realtimePeerPlan = options.mode === "realtime" ? options.realtimePeerPlan : undefined;
    // A prepared refresh replaces only the call, not its queued Pi work.
    if (!options.preparedRealtimeContext)
        options.messages.setContext(options.ctx);
    runtime.state =
        options.mode === "realtime"
            ? { type: "connecting", mode: "realtime", phase: "authorizing" }
            : { type: "connecting", mode: "dictation", phase: "authorizing" };
    const setStartupStatus = (status) => {
        if (startGeneration !== runtime.startGeneration ||
            runtime.startAbortController !== startAbortController ||
            runtime.state.type !== "connecting")
            return;
        options.onStatus(status);
        options.realtimePeerPlan?.onStatus?.(status);
    };
    setStartupStatus("connecting…");
    try {
        const startup = await interruptible(Promise.all([
            resolveCodexVoiceAuth(options.ctx),
            options.mode === "realtime"
                ? options.preparedRealtimeContext
                    ? Promise.resolve(options.preparedRealtimeContext)
                    : prepareControllerRealtimeContext({
                        ctx: options.ctx,
                        config: options.config,
                        onSummaryStatus: (active) => {
                            setStartupStatus(active ? "summarizing…" : "connecting…");
                        },
                        signal: startSignal,
                    })
                : Promise.resolve(undefined),
        ]), startSignal);
        if (startup === CANCELLED) {
            cancelStart(runtime, startGeneration);
            return;
        }
        const [auth, realtimeContext] = startup;
        if (startGeneration !== runtime.startGeneration ||
            runtime.state.type !== "connecting")
            return;
        if (options.mode === "dictation")
            await startDictation(options, auth);
        else
            await startConversation(options, auth, realtimePrompt, realtimeContext?.initialItems, startSignal);
        if (startSignal.aborted) {
            await currentVoiceSession(runtime.state)?.close();
            cancelStart(runtime, startGeneration);
            return;
        }
        const activeState = snapshotState(runtime);
        if (options.mode === "realtime") {
            if (activeState.type !== "conversation") {
                return;
            }
            if (realtimeContext?.summary)
                options.messages.contextSummary(realtimeContext.summary);
            if (runtime.announcedMode !== options.mode) {
                runtime.announcedMode = options.mode;
                options.messages.modeStarted(options.mode);
            }
            return activeState.session;
        }
        if (activeState.type !== "dictation")
            return;
        runtime.announcedMode = options.mode;
        options.messages.modeStarted(options.mode);
        return undefined;
    }
    catch (error) {
        if (startSignal.aborted) {
            await currentVoiceSession(runtime.state)?.close();
            cancelStart(runtime, startGeneration);
            return;
        }
        if (startGeneration !== runtime.startGeneration)
            return;
        options.onError(error instanceof Error ? error : new Error(String(error)));
        return undefined;
    }
}
async function startConversation(options, auth, instructions, initialItems, signal) {
    const { runtime } = options;
    const connecting = runtime.state;
    if (connecting.type !== "connecting" ||
        connecting.mode !== "realtime" ||
        connecting.phase !== "authorizing")
        return;
    const peer = options.realtimePeerPlan?.createPeer();
    await startControllerConversation({
        auth,
        config: options.config,
        instructions,
        initialItems,
        inputMuted: options.inputMuted,
        greeting: options.resume
            ? undefined
            : initialItems?.length
                ? "contextual"
                : "fresh",
        peer,
        signal,
        lifecycle: {
            stillAuthorizing: () => runtime.state === connecting,
            onCreated: (session) => {
                runtime.state = {
                    type: "connecting",
                    mode: "realtime",
                    phase: "starting",
                    session,
                };
            },
            isCurrent: (session) => currentVoiceSession(runtime.state) === session,
            onActive: (session) => {
                runtime.state = { type: "conversation", session };
                if (peer)
                    options.realtimePeerPlan?.onActive?.(session, peer);
            },
            onError: (session, error) => {
                if (currentVoiceSession(runtime.state) === session)
                    options.onError(error, session);
            },
            onDrop: (session, error) => {
                if (currentVoiceSession(runtime.state) === session)
                    options.onDrop(session, error);
            },
            onStatus: options.onStatus,
            onTurn: (session, turn) => { void options.messages.voiceTurn(turn, session); },
            onEvent: (event) => options.messages.realtimeEvent(event),
            onUserTranscript: (transcript) => options.messages.userTranscript(transcript),
            onTranscriptTail: (transcript) => options.messages.retainTranscriptTail(transcript),
        },
    });
}
async function startDictation(options, auth) {
    const { runtime } = options;
    const connecting = runtime.state;
    if (connecting.type !== "connecting" ||
        connecting.mode !== "dictation" ||
        connecting.phase !== "authorizing")
        return;
    await startControllerDictation({
        auth,
        config: options.config,
        lifecycle: {
            stillAuthorizing: () => runtime.state === connecting,
            onCreated: (session) => {
                runtime.state = {
                    type: "connecting",
                    mode: "dictation",
                    phase: "starting",
                    session,
                };
            },
            isCurrent: (session) => currentVoiceSession(runtime.state) === session,
            onActive: (session) => {
                runtime.state = { type: "dictation", session };
            },
            onError: (session, error) => {
                if (currentVoiceSession(runtime.state) === session)
                    options.onError(error);
            },
            onStatus: options.onStatus,
            onTranscript: (transcript) => runtime.context?.ui.pasteToEditor(transcript),
        },
    });
}
function cancelStart(runtime, startGeneration) {
    if (startGeneration !== runtime.startGeneration)
        return;
    runtime.state = { type: "idle" };
    runtime.config = undefined;
    runtime.realtimePeerPlan = undefined;
    runtime.voiceStatus = "";
    runtime.inputTooQuiet = false;
    runtime.context?.ui.setStatus(VOICE_STATUS_KEY, undefined);
}
function snapshotState(runtime) {
    return runtime.state;
}
