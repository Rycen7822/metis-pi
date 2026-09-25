/** A UTF-16 ring: retain the configured character budget without keeping it all on the heap. */
export declare class ExecOutputBuffer {
    startOffset: number;
    endOffset: number;
    private memory;
    private spool;
    private spoolDisabled;
    private failure;
    private disposed;
    private readonly maxChars;
    constructor(maxChars: number);
    get length(): number;
    append(text: string): void;
    /** String.slice semantics, but only the requested range is materialized. */
    slice(start?: number, end?: number): string;
    dispose(): void;
    private openSpool;
    private writeRing;
    private readRange;
    private fail;
    private closeSpool;
}
