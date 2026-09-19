import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { CodexRealtimePeerEvent, CodexRealtimeWebRtcPeer } from "../conversation/peer.ts";
export declare class LanHostRealtimePeer implements CodexRealtimeWebRtcPeer {
    readonly kind: "webrtc";
    private readonly helper;
    private readonly onAudio;
    constructor(options: {
        onAudio(pcm: Buffer): void;
    });
    onEvent(listener: (event: CodexRealtimePeerEvent) => void): () => void;
    onExit(listener: (error: Error) => void): () => void;
    start(config: CodexConversionConfig): Promise<string>;
    applyAnswer(sdp: string): void;
    sendData(message: unknown): void;
    sendAudio(pcm: Buffer): void;
    setInputMuted(muted: boolean): void;
    close(): Promise<void>;
}
