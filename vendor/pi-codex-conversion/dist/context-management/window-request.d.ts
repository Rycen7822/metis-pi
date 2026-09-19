import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextWindowIdentity } from "./messages.ts";
export declare function rewriteWindowPayload(payload: unknown, ctx: ExtensionContext, identity: ContextWindowIdentity | undefined): unknown;
export declare function rewriteWindowHeaders(headers: ProviderHeaders, ctx: ExtensionContext, identity: ContextWindowIdentity | undefined): void;
