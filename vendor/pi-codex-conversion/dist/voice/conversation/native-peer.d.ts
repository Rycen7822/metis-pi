import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { CodexRealtimePeerEvent, CodexRealtimeWebRtcPeer } from "./peer.ts";
export declare class NativeCodexRealtimePeer implements CodexRealtimeWebRtcPeer {
    readonly kind: "webrtc";
    private readonly helper;
    onEvent(listener: (event: CodexRealtimePeerEvent) => void): () => void;
    onExit(listener: (error: Error) => void): () => void;
    start(config: CodexConversionConfig): Promise<string>;
    applyAnswer(sdp: string): void;
    sendData(message: unknown): void;
    setInputMuted(muted: boolean): void;
    close(): Promise<void>;
}
