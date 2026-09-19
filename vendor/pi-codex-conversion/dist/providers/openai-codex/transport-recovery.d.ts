import { type Api, type AssistantMessageEventStream, type Context, type Model, type Transport } from "@earendil-works/pi-ai";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import { type CodexTurnState } from "./turn-state.ts";
import type { CodexDiagnosticsSink, CodexProviderStreamOptions, OpenAICodexStreamOptions, ResponsesBody } from "./types.ts";
export type CodexProviderRuntimeConfig = Pick<CodexConversionConfig, "openai" | "executionMode"> & Partial<Pick<CodexConversionConfig, "compaction">>;
export interface CodexTransportRecoveryDependencies {
    getConfig?: () => CodexProviderRuntimeConfig | undefined;
    useResponsesLite?: (model: Model<Api>) => boolean;
    turnState?: CodexTurnState | undefined;
    onPreparedPayload?: ((payload: ResponsesBody) => void) | undefined;
    onStreamSettled?: () => void | undefined;
    getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
    prepareRequestBody: <TApi extends Api>(model: Model<TApi>, context: Context, options: OpenAICodexStreamOptions | undefined, responsesLite: boolean) => Promise<ResponsesBody>;
}
export declare function getEffectiveCodexTransport(transport: Transport | undefined, config: Pick<CodexConversionConfig["openai"], "forceCachedWebSockets"> | undefined, sessionId?: string | undefined): Transport;
export declare function createCodexTransportStream<TApi extends Api>(model: Model<TApi>, context: Context, options: CodexProviderStreamOptions | undefined, deps: CodexTransportRecoveryDependencies): AssistantMessageEventStream;
