import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface CodexVoiceAuth {
    headers: Headers;
    baseUrl: string;
    officialCodex: boolean;
    env?: Record<string, string>;
}
export declare function resolveCodexVoiceAuth(ctx: ExtensionContext): Promise<CodexVoiceAuth>;
