import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE = "Codex-backed tool requires an OpenAI Codex-compatible Responses provider or /login openai-codex";
export interface CodexToolProvider {
    route: "openai-codex" | "configured-responses";
    baseUrl: string;
    responsesUrl: string;
    searchUrl: string;
    model: string | undefined;
    token: string;
    accountId: string;
}
export type AllowConfiguredCodexToolProvider = (model: ExtensionContext["model"]) => boolean;
export type CodexToolProviderResolver = (ctx: ExtensionContext) => Promise<CodexToolProvider>;
export declare function registerCodexToolProviderPolicy(pi: ExtensionAPI, allows: (model: ExtensionContext["model"]) => boolean): () => void;
export declare function registerCodexToolProviderResolver(pi: ExtensionAPI, resolver: CodexToolProviderResolver): () => void;
export declare function resolveCodexApiProviderBaseUrl(modelBaseUrl: string | undefined): string;
export declare function resolveCodexResponsesUrl(providerBaseUrl: string): string;
export declare function resolveCodexSearchUrl(providerBaseUrl: string): string;
export declare function resolveCodexToolProvider(ctx: ExtensionContext, allowConfiguredProvider?: AllowConfiguredCodexToolProvider): Promise<CodexToolProvider>;
export declare function codexToolProviderHeaders(provider: CodexToolProvider): Headers;
