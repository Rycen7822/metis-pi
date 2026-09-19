import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const DEFAULT_SUPPORTED_PROVIDERS: readonly ["openai", "openai-codex"];
export declare const DEFAULT_SUPPORTED_APIS: readonly ["openai-responses", "openai-codex-responses"];
type DefaultSupportedApi = (typeof DEFAULT_SUPPORTED_APIS)[number];
type RuntimeModel = Model<Api>;
type NativeCompactionFailureReason = "disabled" | "missing-model" | "unsupported-provider" | "unsupported-api" | "missing-base-url" | "missing-api-key" | "unsupported-payload" | "payload-model-mismatch";
export type NativeCompactionSupportOptions = {
    enabled?: boolean | undefined;
    supportedProviders?: readonly string[] | undefined;
    supportedApis?: readonly string[] | undefined;
};
export type ResponsesCompatibleRequestPayload = {
    model: string;
    input: unknown[];
    instructions?: unknown | undefined;
    [key: string]: unknown;
};
export type NativeCompactionRuntime = {
    provider: string;
    api: DefaultSupportedApi;
    apiFamily: DefaultSupportedApi;
    codexTransport: boolean;
    model: string;
    baseUrl: string;
    apiKey?: string | undefined;
    headers?: ProviderHeaders | undefined;
    env?: Record<string, string> | undefined;
    payload?: ResponsesCompatibleRequestPayload | undefined;
    currentModel: RuntimeModel;
};
export type NativeCompactionEnvironmentFailure = {
    ok: false;
    reason: NativeCompactionFailureReason;
    provider?: string | undefined;
    api?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | undefined;
};
export type NativeCompactionEnvironmentSuccess = {
    ok: true;
    runtime: NativeCompactionRuntime;
};
export type NativeCompactionEnvironmentResolution = NativeCompactionEnvironmentFailure | NativeCompactionEnvironmentSuccess;
export declare function normalizeBaseUrl(baseUrl: string | undefined | null): string | undefined;
export declare function isSupportedApi(api: string): api is DefaultSupportedApi;
export declare function isResponsesCompatiblePayload(payload: unknown): payload is ResponsesCompatibleRequestPayload;
export declare function getRuntimeModelDescriptor(model: RuntimeModel | undefined): {
    provider?: string | undefined;
    api?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | undefined;
};
export declare function resolveNativeCompactionEnvironment(ctx: ExtensionContext, options?: NativeCompactionSupportOptions, payload?: unknown): Promise<NativeCompactionEnvironmentResolution>;
export {};
