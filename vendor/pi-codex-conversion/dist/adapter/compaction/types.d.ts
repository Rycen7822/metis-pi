import type { CompactionEntry, CompactionResult } from "@earendil-works/pi-coding-agent";
import { type CodexCompactionDiagnostic } from "./diagnostics.ts";
declare const LEGACY_NATIVE_COMPACTION_STRATEGY = "openai-native-compact-v1";
export declare const NATIVE_COMPACTION_STRATEGY = "openai-responses-compaction-v2";
export declare const NATIVE_COMPACTION_SHIM_SUMMARY = "[OpenAI native compaction checkpoint]";
export declare const NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE = "codex-native-compaction-display";
export declare const NATIVE_COMPACTION_DISPLAY_TEXT: string;
export declare const NATIVE_COMPACTION_PORTABLE_DISPLAY_TEXT: string;
export type NativeCompactionDisplayEntry = {
    content: string;
    compactionEntryId: string;
    kind?: "usage" | undefined;
};
export type NativeCompactionStrategy = typeof NATIVE_COMPACTION_STRATEGY;
type PersistedNativeCompactionStrategy = NativeCompactionStrategy | typeof LEGACY_NATIVE_COMPACTION_STRATEGY;
export type NativeCompactionRequestMeta = {
    tokensBefore?: number | undefined;
    previousSummaryPresent?: boolean | undefined;
    compactedKeptWindow?: boolean | undefined;
};
export type NativeCompactionUsage = {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    diagnostic?: CodexCompactionDiagnostic | undefined;
};
export type NativeCompactionIdentity = {
    provider: string;
    api: string;
    model: string;
    baseUrl: string;
};
export type NativeCompactionDetails = NativeCompactionIdentity & {
    strategy: PersistedNativeCompactionStrategy;
    compactedWindow: unknown[];
    compactResponseId?: string | undefined;
    createdAt: string;
    requestMeta?: NativeCompactionRequestMeta | undefined;
    usage?: NativeCompactionUsage | undefined;
};
export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails>;
export type CreateNativeCompactionDetailsInput = NativeCompactionIdentity & {
    compactedWindow: unknown[];
    compactResponseId?: string | undefined;
    createdAt?: string | undefined;
    requestMeta?: NativeCompactionRequestMeta | undefined;
    usage?: NativeCompactionUsage | undefined;
};
export type CreateNativeCompactionShimResultInput = {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details: NativeCompactionDetails;
    usage?: CompactionResult["usage"];
};
export declare function isNativeCompactionRequestMeta(value: unknown): value is NativeCompactionRequestMeta;
export declare function isNativeCompactionUsage(value: unknown): value is NativeCompactionUsage;
export declare function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails;
export declare function isNativeCompactionEntry(value: unknown): value is NativeCompactionEntry;
export declare function hasPortableNativeCompactionSummary(entry: CompactionEntry | undefined): boolean;
export declare function createNativeCompactionDetails(input: CreateNativeCompactionDetailsInput): NativeCompactionDetails;
export declare function createNativeCompactionShimResult(input: CreateNativeCompactionShimResultInput): CompactionResult<NativeCompactionDetails>;
export {};
