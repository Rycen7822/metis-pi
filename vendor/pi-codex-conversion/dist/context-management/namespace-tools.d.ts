import { type AssistantMessageEventStream, type Context, type ToolCall } from "@earendil-works/pi-ai";
export declare function rewriteContextNamespaceTools(payload: unknown, options?: {
    encrypted?: boolean;
}): unknown;
export declare function hasContextNamespaceRouters(context: Pick<Context, "tools">): boolean;
export declare function unrouteContextNamespaceToolCall(call: ToolCall): ToolCall;
export declare function routeContextNamespaceToolStream(source: AssistantMessageEventStream): AssistantMessageEventStream;
