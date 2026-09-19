import type { ResponsesCompatibleRequestPayload } from "../compaction/compaction-runtime.ts";
import type { ResponsesInputMessageItem } from "../compaction/serializer.js";
export type FreshAuthoritativePreamble = {
    instructions?: string | undefined;
    leadingInput: ResponsesInputMessageItem[];
    trailingInput: ResponsesInputMessageItem[];
};
export declare function extractFreshAuthoritativePreamble(payload: ResponsesCompatibleRequestPayload, persisted?: readonly unknown[]): FreshAuthoritativePreamble | undefined;
