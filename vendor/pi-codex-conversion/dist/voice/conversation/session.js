import { randomUUID } from "node:crypto";
import { CANCELLED, interruptible } from "../cancellation.js";
import { MAX_REALTIME_VOICE_INPUT_BYTES } from "../prompts.js";
import { RealtimeVoiceTurnTracker } from "../turns.js";
import { buildRealtimeCallRequest, setupRealtimeCall, } from "./call-setup.js";
import { RealtimeDelegationHandoff, } from "./handoff.js";
import { boundedAssistantTranscript, boundedTranscript, realtimePeerStateFailure, realtimeEventDetails, realtimeEventIdentity, remoteError, transcriptItemText, utf8Chunks, } from "./wire.js";
const PEER_READY_TIMEOUT_MS = 15_000;
const CONTEXT_APPEND_CHUNK_BYTES = 500;
export class CodexRealtimeConversation {
    callbacks;
    peer;
    turnTracker = new RealtimeVoiceTurnTracker();
    handoff;
    state = "idle";
    setupAbortController;
    peerReady;
    closePromise;
    callSetup = setupRealtimeCall;
    inputMuted = false;
    established = false;
    speakableResponsePending = false;
    callId = randomUUID();
    inputChanged = Promise.withResolvers();
    constructor(callbacks, peer) {
        this.callbacks = callbacks;
        this.peer = peer;
        this.handoff = new RealtimeDelegationHandoff({
            isActive: () => this.state === "active",
            onContext: (target, channel, content) => this.sendContext(target, channel, content),
            onSettled: (id) => this.turnTracker.delegationSettled(id),
        });
        this.peer.onEvent((event) => this.handlePeerEvent(event));
        this.peer.onExit((error) => this.drop(error));
    }
    async start(auth, config, instructions, initialItems, inputMuted = false) {
        this.state = "starting";
        const sdp = await this.peer.start(config);
        if (this.state !== "starting")
            return;
        const headers = new Headers(auth.headers);
        headers.set("openai-alpha", "quicksilver=v2");
        headers.set("content-type", "application/json");
        const endpoint = `${auth.baseUrl.replace(/\/+$/, "")}/realtime/calls?intent=quicksilver&architecture=avas`;
        const setupAbortController = new AbortController();
        this.setupAbortController = setupAbortController;
        const requestBody = JSON.stringify(buildRealtimeCallRequest(sdp, config, instructions, initialItems));
        let status;
        let answer;
        try {
            ({ status, answer } = await this.callSetup(endpoint, headers, setupAbortController.signal, requestBody, auth.env));
        }
        finally {
            if (this.setupAbortController === setupAbortController)
                this.setupAbortController = undefined;
        }
        if (this.state !== "starting")
            return;
        if (status !== 201)
            throw new Error(`Codex voice call failed (${status}): ${answer.slice(0, 1_000)}`);
        this.state = "active";
        if (inputMuted)
            this.setInputMuted(true);
        const peerReady = Promise.withResolvers();
        this.peerReady = peerReady;
        this.callbacks.onStatus("connecting…");
        this.peer.applyAnswer(answer);
        let timeout;
        try {
            await Promise.race([
                peerReady.promise,
                new Promise((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error("Codex voice peer did not become ready")), PEER_READY_TIMEOUT_MS);
                }),
            ]);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (this.peerReady === peerReady)
                this.peerReady = undefined;
        }
    }
    markEstablished() {
        if (this.state === "active")
            this.established = true;
    }
    greet(contextual) {
        if (this.state !== "active")
            return;
        this.appendSpeakableContext(contextual
            ? "The voice session has started with context from the ongoing conversation. Greet the user by naturally acknowledging the relevant topic, state, or next step. Do not give a generic hello or repeat the context summary. Then wait for them to speak."
            : "The voice session has started. Give the user a short, distinctive greeting with some personality; a bare generic hello is not enough. Then wait for them to speak.");
    }
    announcePrompt(prompt) {
        if (this.state !== "active")
            return;
        this.appendSpeakableContext(prompt);
    }
    announceContextTransition(reason) {
        if (this.state !== "active")
            return;
        const prompt = reason === "rollover"
            ? "I'm moving to a fresh context window and carrying our conversation forward. Briefly acknowledge this in your natural voice."
            : reason === "overflow"
                ? "The conversation exceeded its context limit and is being compacted. The interrupted work will continue automatically afterward. Please announce this briefly in your natural voice."
                : "The conversation is being compacted. Please announce this briefly in your natural voice.";
        this.appendSpeakableContext(prompt);
    }
    appendSpeakableContext(text) {
        this.sendContext({ type: "session" }, "speakable", text);
    }
    activateDelegation(id) {
        this.handoff.activate(id);
    }
    piInput(input, streamingBehavior) {
        return this.handoff.piInput(input, streamingBehavior);
    }
    piUserMessage(message) {
        return this.handoff.piUserMessage(message);
    }
    get microphoneMuted() {
        return this.inputMuted;
    }
    setInputMuted(muted) {
        if (this.state !== "active" || this.inputMuted === muted)
            return;
        this.peer.setInputMuted(muted);
        this.inputMuted = muted;
    }
    streamAgentDelta(delta) {
        this.handoff.stream(delta);
    }
    agentProgress(content) {
        this.handoff.progress(content);
    }
    agentResult(content) {
        this.handoff.result(content);
    }
    settleAgentTurn() {
        this.handoff.settle();
        if (!this.speakableResponsePending)
            this.callbacks.onStatus("listening");
    }
    async close() {
        this.closePromise ??= this.closeSession();
        return this.closePromise;
    }
    async waitForInput(signal) {
        while (this.state === "active" && this.turnTracker.hasPendingInput) {
            if (await interruptible(this.inputChanged.promise, signal) === CANCELLED)
                signal.throwIfAborted();
        }
    }
    async closeSession() {
        this.state = "closed";
        this.established = false;
        this.speakableResponsePending = false;
        this.abortSetup();
        this.handoff.clear();
        this.drainConversation();
        this.inputChanged.resolve();
        this.inputMuted = false;
        this.peerReady?.resolve();
        this.peerReady = undefined;
        await this.peer.close();
    }
    handlePeerEvent(event) {
        if (this.state === "idle" ||
            this.state === "closed" ||
            this.state === "failed")
            return;
        if (event.type === "error") {
            const error = new Error(event.message);
            if (terminalTransportError(event.message))
                this.drop(error);
            else
                this.fail(error);
            return;
        }
        if (event.type === "data") {
            this.handleServerEvent(event.message);
            this.inputChanged.resolve();
            this.inputChanged = Promise.withResolvers();
        }
        if (event.type === "state")
            this.handleHelperState(event.state);
    }
    handleHelperState(state) {
        const failure = realtimePeerStateFailure(state);
        if (failure) {
            this.drop(new Error(failure));
            return;
        }
        if (state === "ready" || state === "listening") {
            this.peerReady?.resolve();
            this.callbacks.onStatus("listening");
        }
        else if (state === "connecting" || state === "connected")
            this.callbacks.onStatus("connecting…");
        else if (state === "disconnected")
            this.callbacks.onStatus("reconnecting…");
    }
    handleServerEvent(value) {
        if (!value || typeof value !== "object")
            return;
        const event = value;
        if (event["type"] === "error") {
            this.fail(new Error(remoteError(event)));
            return;
        }
        if (event["type"] === "turn.created" || event["type"] === "delegation.context.appended" || event["type"] === "session.context.appended") {
            this.callbacks.onEvent?.(realtimeEventDetails(this.callId, event, undefined, true));
            return;
        }
        if (event["type"] === "input_transcript.added") {
            const input = boundedTranscript(transcriptItemText(event["item"]));
            if (input === "oversized") {
                this.fail(new Error("Codex voice transcript was oversized"));
                return;
            }
            if (input) {
                this.callbacks.onEvent?.(realtimeEventDetails(this.callId, event, input, true));
                this.turnTracker.inputAdded(input);
            }
            return;
        }
        if (event["type"] === "output_transcript.added") {
            const output = boundedAssistantTranscript(transcriptItemText(event["item"]));
            if (output)
                this.turnTracker.outputAdded(output);
            this.callbacks.onStatus("speaking");
            return;
        }
        if (event["type"] === "turn.done") {
            this.callbacks.onEvent?.(realtimeEventDetails(this.callId, event, undefined, true));
            this.handleCompletedTurn(event["turn"]);
            return;
        }
        if (event["type"] !== "delegation.created" || this.state !== "active")
            return;
        const item = event["item"];
        if (!item || typeof item !== "object")
            return;
        const record = item;
        const delegationId = realtimeEventIdentity(record);
        if (record["type"] !== "delegation" ||
            record["target"] !== "client" ||
            !delegationId ||
            !Array.isArray(record["content"]))
            return;
        const input = record["content"]
            .flatMap((part) => part &&
            typeof part === "object" &&
            part["type"] === "input_text" &&
            typeof part["text"] === "string"
            ? [part["text"]]
            : [])
            .join("")
            .trim();
        if (!input || Buffer.byteLength(input) > MAX_REALTIME_VOICE_INPUT_BYTES) {
            this.fail(new Error("Codex voice delegation was empty or oversized"));
            return;
        }
        const delegated = this.turnTracker.delegated(input, delegationId);
        this.callbacks.onEvent?.(realtimeEventDetails(this.callId, event, input, Boolean(delegated)));
        if (!delegated)
            return;
        if (delegated.displayInput)
            this.callbacks.onUserTranscript(input);
        this.callbacks.onTurn(delegated.turn);
    }
    handleCompletedTurn(turn) {
        if (!turn || typeof turn !== "object")
            return;
        const record = turn;
        if (record["role"] === "user") {
            const input = boundedTranscript(record["transcript"]);
            if (input === "oversized") {
                this.fail(new Error("Codex voice transcript was oversized"));
                return;
            }
            if (input && this.turnTracker.userFinished(input))
                this.callbacks.onUserTranscript(input);
            this.callbacks.onStatus("responding");
            return;
        }
        if (record["role"] !== "assistant")
            return;
        const completed = this.turnTracker.assistantFinished(boundedAssistantTranscript(record["transcript"]));
        this.speakableResponsePending = false;
        this.callbacks.onStatus("listening");
        if (completed)
            this.callbacks.onTurn(completed);
    }
    sendContext(target, channel, content) {
        try {
            if (channel === "speakable") {
                this.speakableResponsePending = true;
                this.callbacks.onStatus("speaking");
            }
            for (const text of utf8Chunks(content, CONTEXT_APPEND_CHUNK_BYTES)) {
                this.peer.sendData(target.type === "delegation"
                    ? {
                        type: "delegation.context.append",
                        delegation_item_id: target.id,
                        channel,
                        content: [{ type: "input_text", text }],
                    }
                    : {
                        type: "session.context.append",
                        channel,
                        content: [{ type: "input_text", text }],
                    });
            }
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    abortSetup() {
        this.setupAbortController?.abort();
        this.setupAbortController = undefined;
    }
    drainConversation() {
        for (const turn of this.turnTracker.drainConversationTurns())
            this.callbacks.onTurn(turn);
        const transcriptTail = this.turnTracker.takeTranscriptTail();
        if (transcriptTail)
            this.callbacks.onTranscriptTail(transcriptTail);
        this.turnTracker.reset();
    }
    fail(error) {
        this.finishFailure(error, false);
    }
    drop(error) {
        this.finishFailure(error, this.established);
    }
    finishFailure(error, dropped) {
        if (this.state === "idle" ||
            this.state === "closed" ||
            this.state === "failed")
            return;
        this.state = "failed";
        this.established = false;
        this.speakableResponsePending = false;
        this.abortSetup();
        this.handoff.clear();
        this.drainConversation();
        this.peerReady?.resolve();
        this.peerReady = undefined;
        if (dropped)
            this.callbacks.onDrop(error);
        else
            this.callbacks.onError(error);
        void this.close();
    }
}
function terminalTransportError(message) {
    return (message === "DataChannel is not opened" ||
        message.startsWith("realtime speaker stream ended:") ||
        message.startsWith("realtime microphone stream failed:"));
}
