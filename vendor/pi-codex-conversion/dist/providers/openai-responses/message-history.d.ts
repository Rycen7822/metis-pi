import type { Api, Context, Model } from "@earendil-works/pi-ai";
type Message = Context["messages"][number];
export declare function normalizeResponsesMessageHistory(messages: Context["messages"], model: Model<Api>, normalizeToolCallId?: (id: string, targetModel: Model<Api>, source: Extract<Message, {
    role: "assistant";
}>) => string): Context["messages"];
export {};
