import { type CodexConversionConfig } from "./activation/config.ts";
export declare function applyCodexRequestOptions(payload: unknown, config: CodexConversionConfig, options?: {
    serviceTier?: boolean | undefined;
    verbosity?: boolean | undefined;
}): unknown;
