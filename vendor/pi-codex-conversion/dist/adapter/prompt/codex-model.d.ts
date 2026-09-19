import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface CodexLikeModelDescriptor {
    provider: string;
    api: string;
    id: string;
    baseUrl: string;
}
export declare function isOpenAICodexModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean;
export declare function isCanonicalCodexBaseUrl(value: string | null | undefined): boolean;
export declare function isCanonicalCodexSubscriptionModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean;
export declare function isCodexTransportModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean;
export declare function isResponsesModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean;
export declare function isCodexLikeModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean;
export declare function isCodexTransportContext(ctx: Pick<ExtensionContext, "model">): boolean;
export declare function isResponsesContext(ctx: Pick<ExtensionContext, "model">): boolean;
export declare function isOpenAIResponsesContext(ctx: Pick<ExtensionContext, "model">): boolean;
