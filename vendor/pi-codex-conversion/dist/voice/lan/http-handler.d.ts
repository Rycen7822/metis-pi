import type { IncomingMessage, ServerResponse } from "node:http";
import type { LanVoiceBrowserClients } from "./browser-clients.ts";
import type { LanVoiceActivity } from "./activity.ts";
import { type LanVoiceDraft } from "./draft.ts";
export interface LanVoiceHttpHandlers {
    activity: LanVoiceActivity;
    clients: LanVoiceBrowserClients;
    draft: LanVoiceDraft;
    renderManifest(): string;
    renderPage(): string;
    inputMuted(): boolean;
    ownerIsActive(): boolean;
    readonly closing: boolean;
}
export declare function handleLanVoiceHttpRequest(request: IncomingMessage, response: ServerResponse, handlers: LanVoiceHttpHandlers): Promise<void>;
export declare function boundedString(value: unknown, maxBytes: number): string | undefined;
