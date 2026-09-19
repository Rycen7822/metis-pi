export interface ImageGenerationCallItem {
    type: "image_generation_call";
    id: string;
    status: string;
    result: string | null;
    revised_prompt?: string | undefined;
}
export interface ImageGenerationCallBlock {
    type: "image_generation_call";
    item: ImageGenerationCallItem;
}
export interface WebSearchCallItem {
    type: "web_search_call";
    id: string;
    status?: string | undefined;
    action?: unknown | undefined;
    results?: unknown | undefined;
}
export interface WebSearchCallBlock {
    type: "web_search_call";
    item: WebSearchCallItem;
}
export type ImageDetail = "auto" | "high" | "original";
export declare function encryptedOutputFromWebRunLike(value: unknown): string | undefined;
export declare function encryptedWebRunOutputFromDetails(details: unknown): string | undefined;
export declare function encryptedToolOutputFromDetails(details: unknown): string | undefined;
export declare function isImageGenerationCallBlock(block: {
    type: string;
    item?: unknown;
}): block is ImageGenerationCallBlock;
export declare function isWebSearchCallBlock(block: {
    type: string;
    item?: unknown;
}): block is WebSearchCallBlock;
export declare function sanitizeImageGenerationCallItem(item: unknown): ImageGenerationCallItem | undefined;
export declare function sanitizeWebSearchCallItem(item: unknown): WebSearchCallItem | undefined;
export declare function imageDetailForResponses(block: unknown): ImageDetail;
