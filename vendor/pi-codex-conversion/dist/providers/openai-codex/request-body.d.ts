import { type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { OpenAICodexStreamOptions, ResponsesBody } from "./types.ts";
export declare function buildRequestBody<TApi extends Api>(model: Model<TApi>, context: Context, options?: OpenAICodexStreamOptions): ResponsesBody;
