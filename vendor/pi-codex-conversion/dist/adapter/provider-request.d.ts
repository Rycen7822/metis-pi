import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { AdapterState } from "./activation/state.ts";
export declare function supportsCodexDeveloperMessages(ctx: Pick<ExtensionContext, "model">, state: AdapterState): boolean;
export declare function rewriteCodexProviderHeaders(headers: ProviderHeaders, ctx: ExtensionContext, state: AdapterState): void;
export declare function captureActiveProviderSystemPrompt(payload: unknown, state: AdapterState): void;
export declare function rewriteCodexProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): Promise<unknown | undefined>;
export declare function rewriteCodexPrewarmProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): unknown | undefined;
