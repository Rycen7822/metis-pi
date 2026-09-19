import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type VoiceContextReasoning } from "../adapter/activation/config.ts";
interface VoiceContextModelSelection {
    provider: string;
    modelId: string;
    reasoning?: VoiceContextReasoning | undefined;
}
interface NativeVoiceContextRequest {
    ctx: ExtensionContext;
    entries: readonly SessionEntry[];
    model: VoiceContextModelSelection;
    systemPrompt: string;
    request: string;
    signal?: AbortSignal | undefined;
}
export declare function createNativeVoiceContextSummary(request: NativeVoiceContextRequest): Promise<string>;
export {};
