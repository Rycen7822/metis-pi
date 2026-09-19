import { markRealtimePeerInactive, resumeDroppedConversation, } from "./controller-reconnect.js";
import { startControllerMode, } from "./controller-start.js";
import { RealtimeContextRefresh } from "./controller-context.js";
import { currentVoiceSession, prepareRealtimeVoicePrompt, renderVoiceStatus, VOICE_STATUS_KEY, voiceModeForState, } from "./controller-support.js";
import { completedVoiceReasoningSummary } from "./reasoning-summary.js";
import { CodexVoiceSessionMessages, } from "./session-messages.js";
import { formatVoiceAudioError } from "./setup.js";
export class CodexVoiceController {
    runtime = {
        state: { type: "idle" },
        startGeneration: 0,
        voiceStatus: "",
        inputTooQuiet: false,
    };
    messages;
    contextRefresh;
    inputMuteListeners = new Set();
    activePrompts = new Map();
    delegationPreflight = async () => undefined;
    constructor(pi) {
        this.messages = new CodexVoiceSessionMessages(pi, {
            canDelegate: () => this.runtime.state.type === "conversation",
            prepareDelegation: (ctx, signal) => this.delegationPreflight(ctx, signal),
            onDelegation: (id, input, source) => {
                if (this.runtime.state.type !== "conversation")
                    return;
                const current = this.runtime.state.session;
                // Delegation IDs belong to their call. Carried work uses session output.
                if (current === source)
                    current.activateDelegation(id);
                else
                    current.piInput(input);
            },
            onDelegationFailed: () => {
                if (this.runtime.state.type === "conversation")
                    this.runtime.state.session.settleAgentTurn();
            },
            onWorking: () => this.renderStatus("working"),
        });
        this.contextRefresh = new RealtimeContextRefresh(this.runtime, {
            inputMuted: () => this.inputMuted,
            holdDelegations: () => this.messages.holdDelegationsForRefresh(),
            replace: (ctx, config, previous, plan, inputMuted, prepared, signal) => this.replaceRealtimeContext(ctx, config, previous, plan, inputMuted, prepared, signal),
        });
    }
    setDelegationPreflight(preflight) {
        this.delegationPreflight = preflight;
    }
    setPrompt(report) {
        if (!report.active) {
            this.activePrompts.delete(report.id);
            return;
        }
        if (this.activePrompts.get(report.id) === report.prompt)
            return;
        this.activePrompts.delete(report.id);
        this.activePrompts.set(report.id, report.prompt);
        if (this.runtime.state.type === "conversation")
            this.runtime.state.session.announcePrompt(report.prompt);
    }
    announceContextTransition(reason) {
        if (this.runtime.state.type === "conversation")
            this.runtime.state.session.announceContextTransition(reason);
    }
    compactionStarted() {
        this.messages.compactionStarted();
    }
    compactionFinished() {
        this.messages.compactionFinished();
    }
    get status() {
        return this.runtime.state.type;
    }
    get active() {
        return (this.runtime.state.type !== "idle" && this.runtime.state.type !== "failed");
    }
    get activeMode() {
        return this.runtime.announcedMode;
    }
    get inputMuted() {
        return (this.runtime.state.type === "conversation" &&
            this.runtime.state.session.microphoneMuted);
    }
    onInputMuteChange(listener) {
        this.inputMuteListeners.add(listener);
        return () => this.inputMuteListeners.delete(listener);
    }
    setInputMuted(muted) {
        if (this.runtime.state.type !== "conversation" ||
            this.runtime.announcedMode !== "realtime")
            return false;
        const previous = this.runtime.state.session.microphoneMuted;
        this.runtime.state.session.setInputMuted(muted);
        const current = this.runtime.state.session.microphoneMuted;
        if (previous !== current) {
            this.renderCurrentStatus();
            for (const listener of this.inputMuteListeners)
                listener(current);
        }
        return true;
    }
    setInputTooQuiet(inputTooQuiet) {
        const receivesInput = this.runtime.state.type === "conversation" ||
            this.runtime.state.type === "reconnecting" ||
            this.runtime.state.type === "connecting";
        const next = receivesInput && inputTooQuiet;
        if (this.runtime.inputTooQuiet === next)
            return;
        this.runtime.inputTooQuiet = next;
        this.renderCurrentStatus();
    }
    resetContextAnnouncements() {
        this.messages.resetContextAnnouncements();
    }
    resetSessionContext() {
        this.contextRefresh.cancel();
        this.activePrompts.clear();
        this.messages.resetSessionContext();
    }
    announceDictation(ctx) {
        this.messages.setContext(ctx);
        this.messages.modeStarted("dictation");
    }
    async start(ctx, config, mode) {
        await this.startMode(ctx, config, mode);
    }
    async startRealtimeWithPeerPlan(ctx, config, plan, signal) {
        return this.startMode(ctx, config, "realtime", plan, signal);
    }
    async refreshRealtimeContext(ctx, config, options = {}) {
        await this.contextRefresh.run(ctx, config, options);
    }
    prepareRealtimePrompt(ctx) {
        return prepareRealtimeVoicePrompt(ctx);
    }
    async stopConversation(session, options) {
        if (this.currentSession() === session)
            await this.stop(options);
    }
    async stopRealtimeWithPeerPlan(plan, options) {
        if (this.runtime.realtimePeerPlan === plan)
            await this.stop(options);
    }
    setConversationInputActive(session, active) {
        if (this.currentSession() !== session)
            return;
        if (active) {
            if (this.runtime.announcedMode === "realtime")
                return;
            this.runtime.announcedMode = "realtime";
            this.messages.modeStarted("realtime");
            return;
        }
        if (session.microphoneMuted)
            this.setInputMuted(false);
        if (this.runtime.announcedMode !== "realtime")
            return;
        this.runtime.announcedMode = undefined;
        this.messages.conversationInputStopped();
    }
    async startMode(ctx, config, mode, realtimePeerPlan, signal, resume = false, inputMuted = false, preparedRealtimeContext) {
        const session = await startControllerMode({
            runtime: this.runtime,
            messages: this.messages,
            ctx,
            config,
            mode,
            realtimePeerPlan,
            signal,
            resume,
            inputMuted,
            ...(preparedRealtimeContext ? { preparedRealtimeContext } : {}),
            prepareRealtimePrompt: (current) => this.prepareRealtimePrompt(current),
            stopCurrent: () => this.stop({ announce: true }),
            finishCurrentDictation: () => this.finishDictation({ announce: true }),
            onError: (error, session) => this.fail(error, session),
            onDrop: (session, error) => this.drop(session, error),
            onStatus: (status) => this.renderStatus(status),
        });
        const activePrompt = Array.from(this.activePrompts.values()).at(-1);
        if (session && activePrompt)
            session.announcePrompt(activePrompt);
        return session;
    }
    async stop(options) {
        this.contextRefresh.cancel();
        this.runtime.startAbortController?.abort();
        this.runtime.startAbortController = undefined;
        this.runtime.startGeneration += 1;
        const stopGeneration = this.runtime.startGeneration;
        const wasMuted = this.inputMuted;
        const endedMode = options?.announce
            ? this.runtime.announcedMode
            : undefined;
        const session = this.currentSession();
        this.messages.cancelPendingDelegations();
        const closePromise = session?.close();
        this.runtime.state = { type: "idle" };
        this.runtime.announcedMode = undefined;
        this.runtime.config = undefined;
        this.runtime.realtimePeerPlan = undefined;
        this.runtime.voiceStatus = "";
        this.runtime.inputTooQuiet = false;
        this.runtime.context?.ui.setStatus(VOICE_STATUS_KEY, undefined);
        await closePromise;
        await this.messages.waitForDelegations();
        if (wasMuted)
            for (const listener of this.inputMuteListeners)
                listener(false);
        if (this.runtime.startGeneration === stopGeneration)
            this.messages.voiceStopped(endedMode);
    }
    async finishDictation(options) {
        this.runtime.startGeneration += 1;
        const session = this.runtime.state.type === "dictation"
            ? this.runtime.state.session
            : this.runtime.state.type === "connecting" &&
                this.runtime.state.mode === "dictation" &&
                this.runtime.state.phase === "starting"
                ? this.runtime.state.session
                : undefined;
        if (!session) {
            await this.stop(options);
            return;
        }
        await session.finish();
        if (this.currentSession() !== session)
            return;
        const endedMode = options?.announce
            ? this.runtime.announcedMode
            : undefined;
        this.runtime.state = { type: "idle" };
        this.runtime.announcedMode = undefined;
        this.runtime.config = undefined;
        this.runtime.realtimePeerPlan = undefined;
        this.runtime.voiceStatus = "";
        this.runtime.inputTooQuiet = false;
        this.runtime.context?.ui.setStatus(VOICE_STATUS_KEY, undefined);
        this.messages.voiceStopped(endedMode);
    }
    agentStarted() {
        this.messages.agentStarted();
    }
    filterContext(messages) {
        return this.messages.filterContext(messages);
    }
    piInput(input, streamingBehavior) {
        return (this.runtime.state.type === "conversation" &&
            this.runtime.state.session.piInput(input, streamingBehavior));
    }
    piUserMessage(message) {
        return (this.runtime.state.type === "conversation" &&
            this.runtime.state.session.piUserMessage(message));
    }
    streamDelta(delta) {
        if (this.runtime.state.type === "conversation")
            this.runtime.state.session.streamAgentDelta(delta);
    }
    finishAgentMessage(message, forwardReasoningSummaries) {
        if (this.runtime.state.type !== "conversation")
            return;
        const completedText = message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
        if (message.stopReason === "toolUse") {
            const progress = completedText.trim()
                ? completedText
                : forwardReasoningSummaries
                    ? completedVoiceReasoningSummary(message)
                    : undefined;
            if (progress)
                this.runtime.state.session.agentProgress(progress);
            return;
        }
        this.runtime.state.session.agentResult(completedText);
    }
    settleTurn() {
        if (this.runtime.state.type === "conversation")
            this.runtime.state.session.settleAgentTurn();
        this.messages.agentSettled();
    }
    currentSession() {
        return currentVoiceSession(this.runtime.state);
    }
    async replaceRealtimeContext(ctx, config, previous, plan, inputMuted, prepared, signal) {
        if (!this.prepareRealtimePrompt(ctx))
            throw new Error("Realtime voice prompt is unavailable");
        markRealtimePeerInactive(this.runtime, previous, new Error("Realtime voice refreshed for a new context"), true, plan);
        this.runtime.startAbortController?.abort();
        this.runtime.startAbortController = undefined;
        const generation = ++this.runtime.startGeneration;
        this.runtime.state = { type: "reconnecting", session: previous };
        this.renderStatus("reconnecting…");
        plan?.onStatus?.("reconnecting…");
        try {
            await previous.close();
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)), previous);
            return;
        }
        if (signal.aborted ||
            this.runtime.startGeneration !== generation ||
            this.runtime.state.type !== "reconnecting")
            return;
        const replacement = await this.startMode(ctx, config, "realtime", plan, signal, true, inputMuted, prepared);
        if (!replacement && !signal.aborted && this.runtime.state.type === "reconnecting")
            this.fail(new Error("Codex realtime voice could not refresh"), previous);
    }
    fail(error, failedSession) {
        this.contextRefresh.cancel();
        if (this.runtime.state.type === "idle" ||
            this.runtime.state.type === "failed")
            return;
        this.runtime.startAbortController?.abort();
        this.runtime.startAbortController = undefined;
        const mode = voiceModeForState(this.runtime.state);
        const message = this.runtime.config
            ? formatVoiceAudioError(error, mode, this.runtime.config)
            : error.message;
        const failGeneration = ++this.runtime.startGeneration;
        const endedMode = this.runtime.announcedMode;
        const wasMuted = this.inputMuted;
        const session = this.currentSession();
        this.messages.cancelPendingDelegations();
        if (failedSession)
            markRealtimePeerInactive(this.runtime, failedSession, error, false);
        const closePromise = session?.close();
        this.runtime.state = { type: "failed", message };
        this.runtime.announcedMode = undefined;
        this.runtime.config = undefined;
        this.runtime.realtimePeerPlan = undefined;
        this.runtime.voiceStatus = "";
        this.runtime.inputTooQuiet = false;
        this.runtime.context?.ui.setStatus(VOICE_STATUS_KEY, undefined);
        this.runtime.context?.ui.notify(message, "error");
        if (wasMuted)
            for (const listener of this.inputMuteListeners)
                listener(false);
        void (async () => {
            await Promise.allSettled([closePromise]);
            await Promise.allSettled([this.messages.waitForDelegations()]);
            if (this.runtime.startGeneration === failGeneration &&
                this.runtime.state.type === "failed" &&
                this.runtime.state.message === message)
                this.messages.voiceStopped(endedMode);
        })();
    }
    drop(session, error) {
        this.contextRefresh.cancel();
        resumeDroppedConversation({
            runtime: this.runtime,
            messages: this.messages,
            session,
            error,
            callbacks: {
                currentSession: () => this.currentSession(),
                fail: (failure) => this.fail(failure),
                inputMuted: () => this.inputMuted,
                renderCurrentStatus: () => this.renderCurrentStatus(),
                renderStatus: (status) => this.renderStatus(status),
                startReplacement: (ctx, config, plan, inputMuted) => this.startMode(ctx, config, "realtime", plan, undefined, true, inputMuted),
            },
        });
    }
    renderStatus(status) {
        this.runtime.voiceStatus = status;
        this.renderCurrentStatus();
    }
    renderCurrentStatus() {
        renderVoiceStatus(this.runtime.context, this.runtime.voiceStatus, this.inputMuted, this.runtime.inputTooQuiet);
    }
}
