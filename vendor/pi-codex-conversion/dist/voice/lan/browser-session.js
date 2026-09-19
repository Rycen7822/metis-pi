import { WebSocket } from "ws";
import { LanVoiceBrowserConnections } from "./browser-connections.js";
import { errorMessage } from "./browser-wire.js";
export class LanVoiceBrowserSession {
    options;
    connections;
    state = { type: "idle" };
    operation = Promise.resolve();
    conversationOwnerId;
    microphoneLevel;
    constructor(options, connections) {
        this.options = options;
        this.connections = connections;
        this.microphoneLevel = new MicrophoneLevelMonitor(options.onConversationInputTooQuiet);
    }
    get closed() { return this.state.type === "closed"; }
    sendConversationAudio(pcm) {
        const active = this.state;
        if (active.type === "active" && active.mode === "conversation")
            this.connections.sendAudio(active.socket, pcm);
    }
    release(clientId, socket, terminateConversation = false) {
        this.releaseStarting(clientId, socket);
        void this.enqueue(async () => {
            const active = this.state;
            const ownsActive = active.type === "active" && active.clientId === clientId && (!socket || active.socket === socket);
            if (ownsActive)
                this.state = { type: "idle" };
            if (ownsActive && active.mode === "conversation")
                this.microphoneLevel.reset();
            if (terminateConversation && this.conversationOwnerId === clientId) {
                this.conversationOwnerId = undefined;
                await this.options.onConversationActivity(false);
                return;
            }
            if (!ownsActive)
                return;
            if (active.mode === "dictation")
                await this.options.finishDictation(clientId);
        }).catch((error) => this.connections.sendControl(clientId, { type: "error", message: errorMessage(error) }));
    }
    releaseStarting(clientId, socket) {
        const starting = this.state;
        if (starting.type !== "starting" || starting.clientId !== clientId || (socket && starting.socket !== socket))
            return;
        this.state = { type: "idle" };
        if (starting.mode === "dictation")
            void this.options.cancelDictation(clientId).catch((error) => this.connections.sendControl(clientId, { type: "error", message: errorMessage(error) }));
    }
    claim(clientId, socket, mode) {
        const starting = this.state.type === "starting" ? this.state : undefined;
        if (starting && (starting.clientId !== clientId || starting.socket !== socket || starting.mode !== mode)) {
            this.releaseStarting(starting.clientId, starting.socket);
            this.connections.sendControl(starting.clientId, { type: "stop", reason: "replaced" });
            starting.socket.close(4001, "replaced");
        }
        return this.enqueue(async () => {
            if (this.closed)
                return;
            const previous = this.state.type === "active" ? this.state : undefined;
            if (previous?.clientId === clientId && previous.socket === socket && previous.mode === mode)
                return;
            this.state = { type: "idle" };
            if (previous?.mode === "conversation")
                this.microphoneLevel.reset();
            if (previous && previous.socket !== socket) {
                this.connections.sendControl(previous.clientId, { type: "stop", reason: "replaced" });
                previous.socket.close(4001, "replaced");
            }
            if (previous?.mode === "conversation" && mode !== "conversation") {
                this.conversationOwnerId = undefined;
                await this.options.onConversationActivity(false);
            }
            if (previous?.mode === "dictation")
                await this.options.finishDictation(previous.clientId);
            if (this.closed)
                return;
            const starting = { type: "starting", clientId, socket, mode };
            this.state = starting;
            if (mode === "conversation")
                this.conversationOwnerId = clientId;
            try {
                if (mode === "conversation")
                    await this.options.ensureConversation();
                else
                    await this.options.startDictation(clientId);
            }
            catch (error) {
                if (this.state === starting)
                    this.state = { type: "idle" };
                if (mode === "conversation" && this.conversationOwnerId === clientId)
                    this.conversationOwnerId = undefined;
                throw error;
            }
            if (this.closed || this.state !== starting || !this.connections.isCurrentAudio(clientId, socket) || socket.readyState !== WebSocket.OPEN) {
                if (mode === "dictation")
                    await this.options.cancelDictation(clientId);
                return;
            }
            this.state = { type: "active", clientId, socket, mode };
            if (mode === "conversation")
                await this.options.onConversationActivity(true);
            socket.send(JSON.stringify({ type: "active", mode, ...(mode === "conversation" ? { muted: this.options.conversationMuted() } : {}) }));
        });
    }
    finish(clientId, socket, draft, revision, selection) {
        return this.enqueue(async () => {
            const active = this.state;
            if (active.type !== "active" || active.clientId !== clientId || active.socket !== socket || active.mode !== "dictation")
                return;
            this.state = { type: "idle" };
            await this.options.finishDictation(clientId, draft, revision, selection);
            if (!this.closed && socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: "dictation.complete" }));
        });
    }
    cancelDictation(clientId) { return this.options.cancelDictation(clientId); }
    resetConversationInputLevel() { this.microphoneLevel.reset(); }
    mute(clientId, socket, muted) {
        const active = this.state;
        if (active.type === "active" && active.clientId === clientId && active.socket === socket && active.mode === "conversation") {
            this.options.onConversationMute(muted);
        }
    }
    receiveAudio(clientId, socket, pcm) {
        const active = this.state;
        if (active.type !== "active" || active.clientId !== clientId || active.socket !== socket)
            return;
        if (active.mode === "conversation") {
            this.microphoneLevel.append(pcm);
            this.options.onConversationAudio(pcm);
        }
        else
            this.options.onDictationAudio(clientId, pcm);
    }
    async close() {
        const active = this.state;
        if (active.type === "closed") {
            await this.operation;
            return;
        }
        this.state = { type: "closed" };
        const failures = [];
        if (active.type === "active" && active.mode === "conversation") {
            try {
                this.conversationOwnerId = undefined;
                await this.options.onConversationActivity(false);
            }
            catch (error) {
                failures.push(error);
            }
        }
        if ((active.type === "starting" || active.type === "active") && active.mode === "dictation") {
            try {
                await this.options.cancelDictation(active.clientId);
            }
            catch (error) {
                failures.push(error);
            }
        }
        this.connections.close(failures);
        try {
            await this.operation;
        }
        catch (error) {
            failures.push(error);
        }
        if (failures.length === 1)
            throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(failures, "LAN browser cleanup failed");
    }
    enqueue(action) {
        const result = this.operation.then(action, action);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
    }
}
const MICROPHONE_RATE = 24_000;
const DETECTABLE_PEAK = 82;
const HEALTHY_PEAK = 655;
class MicrophoneLevelMonitor {
    onChange;
    samples = 0;
    peak = 0;
    inputTooQuiet = false;
    constructor(onChange) {
        this.onChange = onChange;
    }
    append(pcm) {
        let framePeak = 0;
        for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2)
            framePeak = Math.max(framePeak, Math.abs(pcm.readInt16LE(offset)));
        if (framePeak >= HEALTHY_PEAK) {
            this.samples = 0;
            this.peak = 0;
            this.set(false);
            return;
        }
        this.samples += Math.floor(pcm.byteLength / 2);
        this.peak = Math.max(this.peak, framePeak);
        if (this.samples < MICROPHONE_RATE)
            return;
        if (this.peak >= DETECTABLE_PEAK)
            this.set(true);
        this.samples = 0;
        this.peak = 0;
    }
    reset() {
        this.samples = 0;
        this.peak = 0;
        this.set(false);
    }
    set(inputTooQuiet) {
        if (this.inputTooQuiet === inputTooQuiet)
            return;
        this.inputTooQuiet = inputTooQuiet;
        this.onChange(inputTooQuiet);
    }
}
