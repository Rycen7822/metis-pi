export declare function substituteBlockRefs(text: string, blockSummaryLookup: (blockId: string) => string | undefined, options?: {
    selfBlockId?: string;
}): string;
