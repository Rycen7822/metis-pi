import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
/** Authenticated carrier through Pi's custom-message-to-user conversion. */
export declare class CodexDeveloperMessageBridge {
    private readonly secret;
    private carriers;
    private readonly contextWindowCarriers;
    prepare(messages: readonly AgentMessage[], active: boolean, model?: Model<Api>): AgentMessage[];
    rewritePayload(payload: unknown, model?: Model<Api>): unknown;
    clear(): void;
    private marker;
}
