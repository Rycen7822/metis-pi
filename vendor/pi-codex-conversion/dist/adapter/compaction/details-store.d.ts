import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type NativeCompactionEntry, type NativeCompactionIdentity } from "../compaction/types.js";
export type NativeCompactionEntryMatch = Partial<NativeCompactionIdentity>;
export type LatestNativeCompactionResolutionFailureReason = "no-compaction" | "latest-compaction-not-native" | "latest-native-compaction-mismatch";
export type LatestNativeCompactionResolution = {
    ok: true;
    entry: NativeCompactionEntry;
    index: number;
    latestCompactionIndex: number;
} | {
    ok: false;
    reason: LatestNativeCompactionResolutionFailureReason;
    latestCompactionIndex?: number | undefined;
    latestCompaction?: CompactionEntry | undefined;
};
export declare function isPersistedNativeCompactionEntry(entry: CompactionEntry | SessionEntry | undefined): entry is NativeCompactionEntry;
export declare function findLatestCompactionEntryIndex(entries: readonly SessionEntry[]): number | undefined;
export declare function findLatestCompactionEntry(entries: readonly SessionEntry[]): CompactionEntry | undefined;
export declare function findLatestNativeCompactionEntryIndex(entries: readonly SessionEntry[], match?: NativeCompactionEntryMatch): number | undefined;
export declare function resolveLatestNativeCompactionEntry(entries: readonly SessionEntry[], match?: NativeCompactionEntryMatch): LatestNativeCompactionResolution;
