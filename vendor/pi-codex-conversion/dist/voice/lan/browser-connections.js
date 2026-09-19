import { WebSocket } from "ws";
const MAX_SOCKET_AUDIO_BACKLOG = 24_000 * 2;
export class LanVoiceBrowserConnections {
    eventResponses = new Map();
    audioSockets = new Map();
    connectEvents(clientId, response, closed) {
        if (closed) {
            response.end();
            return;
        }
        const previous = this.eventResponses.get(clientId);
        this.eventResponses.set(clientId, response);
        previous?.end();
        response.once("close", () => {
            if (this.eventResponses.get(clientId) === response)
                this.eventResponses.delete(clientId);
        });
    }
    connectAudio(clientId, socket, closed, callbacks) {
        if (closed) {
            socket.close(1012, "server closing");
            return;
        }
        const previous = this.audioSockets.get(clientId);
        this.audioSockets.set(clientId, socket);
        if (previous)
            callbacks.onReplaced(previous);
        previous?.close(4001, "replaced");
        socket.send(JSON.stringify({ type: "connected" }));
        socket.on("message", callbacks.onMessage);
        socket.once("close", () => {
            if (this.audioSockets.get(clientId) === socket)
                this.audioSockets.delete(clientId);
            callbacks.onClose();
        });
    }
    isCurrentAudio(clientId, socket) {
        return this.audioSockets.get(clientId) === socket;
    }
    sendControl(clientId, value) {
        const response = this.eventResponses.get(clientId);
        if (response && !response.writableEnded)
            response.write(`data: ${JSON.stringify(value)}\n\n`);
    }
    broadcastControl(value) {
        for (const clientId of this.eventResponses.keys())
            this.sendControl(clientId, value);
    }
    sendAudio(socket, pcm) {
        if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_SOCKET_AUDIO_BACKLOG)
            socket.send(pcm);
    }
    heartbeat() {
        for (const response of this.eventResponses.values())
            if (!response.writableEnded)
                response.write(": keepalive\n\n");
    }
    close(failures) {
        for (const socket of this.audioSockets.values()) {
            try {
                socket.terminate();
            }
            catch (error) {
                failures.push(error);
            }
        }
        this.audioSockets.clear();
        for (const response of this.eventResponses.values()) {
            try {
                response.end();
            }
            catch (error) {
                failures.push(error);
            }
        }
        this.eventResponses.clear();
    }
}
