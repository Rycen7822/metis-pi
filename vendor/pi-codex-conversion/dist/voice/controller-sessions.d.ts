import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { CodexVoiceAuth } from "./auth.ts";
import type { RealtimeInitialMessageItem } from "./context.ts";
import type { CodexRealtimePeer } from "./conversation/peer.ts";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
import type { RealtimeVoiceEventDetails } from "./conversation/wire.ts";
import type { CodexDictationSession } from "./dictation/session.ts";
import type { RealtimeVoiceTurn } from "./turns.ts";
interface SessionLifecycle<T> {
    stillAuthorizing(): boolean;
    onCreated(session: T): void;
    isCurrent(session: T): boolean;
    onActive(session: T): void;
    onError(session: T, error: Error): void;
    onStatus(status: string): void;
}
interface RealtimeSessionLifecycle extends SessionLifecycle<CodexRealtimeConversation> {
    onDrop(session: CodexRealtimeConversation, error: Error): void;
    onTurn(session: CodexRealtimeConversation, turn: RealtimeVoiceTurn): void;
    onUserTranscript(transcript: string): void;
    onTranscriptTail(transcript: string): void;
    onEvent(event: RealtimeVoiceEventDetails): void;
}
interface DictationSessionLifecycle extends SessionLifecycle<CodexDictationSession> {
    onTranscript(transcript: string): void;
}
export declare function startControllerConversation(options: {
    auth: CodexVoiceAuth;
    config: CodexConversionConfig;
    instructions: string;
    initialItems?: RealtimeInitialMessageItem[] | undefined;
    inputMuted?: boolean | undefined;
    greeting?: "fresh" | "contextual" | undefined;
    peer?: CodexRealtimePeer | undefined;
    signal?: AbortSignal | undefined;
    lifecycle: RealtimeSessionLifecycle;
}): Promise<void>;
export declare function startControllerDictation(options: {
    auth: CodexVoiceAuth;
    config: CodexConversionConfig;
    lifecycle: DictationSessionLifecycle;
}): Promise<void>;
export {};
