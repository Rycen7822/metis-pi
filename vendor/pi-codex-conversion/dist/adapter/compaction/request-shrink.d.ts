import type { NativeCompactionRequestBody } from "./serializer.ts";
export declare const COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE = "Output exceeded the available model context and was truncated";
export declare const OPENAI_CODEX_COMPACTION_ENDPOINT_BUDGET_TOKENS = 872000;
export type NativeCompactionShrinkResult = {
    request: NativeCompactionRequestBody;
    rewrittenOutputs: number;
};
export type ShrinkNativeCompactionRequestOptions = {
    budgetTokens?: number | null | undefined;
    tokensBefore: number;
};
export type NativeCompactionBudgetOptions = {
    codexTransport: boolean;
    model: string;
    contextWindow?: number | null | undefined;
};
export declare function resolveNativeCompactionRequestBudget(options: NativeCompactionBudgetOptions): number | undefined;
export declare function shrinkNativeCompactionRequestForEndpoint(request: NativeCompactionRequestBody, options: ShrinkNativeCompactionRequestOptions): Promise<NativeCompactionShrinkResult>;
