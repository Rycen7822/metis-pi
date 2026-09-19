import { type CompactionResult, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { type Api, type AssistantMessageEventStream, type Context, type Model, type ProviderHeaders, type SimpleStreamOptions } from "@earendil-works/pi-ai";
type PortableSummaryStream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
export declare function runPortablePiCompaction(event: SessionBeforeCompactEvent, options: {
    model: Model<Api>;
    thinkingLevel?: ExtensionContext["thinkingLevel"];
    apiKey?: string | undefined;
    headers?: ProviderHeaders | undefined;
    env?: Record<string, string> | undefined;
    stream?: PortableSummaryStream | undefined;
    onPayload?: SimpleStreamOptions["onPayload"] | undefined;
}): Promise<CompactionResult>;
export {};
