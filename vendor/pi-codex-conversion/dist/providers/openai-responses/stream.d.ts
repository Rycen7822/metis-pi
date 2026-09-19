import { type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { OpenAIResponsesStreamOptions } from "./shared.ts";
export declare function processResponsesStream<TApi extends Api>(openaiStream: AsyncIterable<ResponseStreamEvent>, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<TApi>, options?: OpenAIResponsesStreamOptions): Promise<void>;
