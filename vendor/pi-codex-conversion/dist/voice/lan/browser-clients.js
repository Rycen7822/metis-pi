import { WebSocket } from "ws";
import { LanVoiceBrowserConnections } from "./browser-connections.js";
import { decodeLanVoiceBrowserInput, errorMessage } from "./browser-wire.js";
import { LanVoiceBrowserSession } from "./browser-session.js";
export { MAX_CONTROL_BYTES } from "./browser-wire.js";
export class LanVoiceBrowserClients {
    connections = new LanVoiceBrowserConnections();
    session;
    constructor(options) {
        this.session = new LanVoiceBrowserSession(options, this.connections);
    }
    connectEvents(clientId, response) {
        this.connections.connectEvents(clientId, response, this.session.closed);
    }
    connectAudio(clientId, socket) {
        this.connections.connectAudio(clientId, socket, this.session.closed, {
            onMessage: (data, isBinary) => this.receive(clientId, socket, data, isBinary),
            onReplaced: (previous) => this.session.releaseStarting(clientId, previous),
            onClose: () => this.session.release(clientId, socket),
        });
    }
    sendControl(clientId, value) {
        this.connections.sendControl(clientId, value);
    }
    broadcastControl(value) {
        this.connections.broadcastControl(value);
    }
    sendConversationAudio(pcm) {
        this.session.sendConversationAudio(pcm);
    }
    resetConversationInputLevel() {
        this.session.resetConversationInputLevel();
    }
    release(clientId, socket, terminateConversation = false) {
        this.session.release(clientId, socket, terminateConversation);
    }
    heartbeat() {
        this.connections.heartbeat();
    }
    async close() {
        await this.session.close();
    }
    receive(clientId, socket, data, isBinary) {
        if (!this.connections.isCurrentAudio(clientId, socket))
            return;
        try {
            const input = decodeLanVoiceBrowserInput(data, isBinary);
            if (input.type === "audio") {
                this.session.receiveAudio(clientId, socket, input.pcm);
                return;
            }
            const message = input.command;
            if (message.type === "start") {
                void this.session.claim(clientId, socket, message.mode).catch((error) => this.sendSocketError(socket, error));
            }
            else if (message.type === "finish") {
                void this.session.finish(clientId, socket, message.draft, message.revision, message.selection).catch((error) => this.sendSocketError(socket, error));
            }
            else if (message.type === "release") {
                this.session.release(clientId, socket, true);
            }
            else if (message.type === "mute") {
                this.session.mute(clientId, socket, message.muted);
            }
            else {
                void this.session.cancelDictation(clientId).catch((error) => this.sendSocketError(socket, error));
            }
        }
        catch {
            socket.close(1003, "invalid message");
        }
    }
    sendSocketError(socket, error) {
        if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "error", message: errorMessage(error) }));
    }
}
