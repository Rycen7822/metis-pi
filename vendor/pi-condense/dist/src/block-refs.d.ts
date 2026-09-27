export declare class BlockRefIssuer {
    private next;
    issue(): string;
    rebuildFrom(existingBlockIds: string[]): void;
}
