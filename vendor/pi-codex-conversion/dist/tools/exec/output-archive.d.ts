/** Durable decoded process output, independent of the bounded display ring. */
export declare class ExecOutputArchive {
    private pending;
    private fd;
    private path;
    private bytes;
    private failed;
    private closed;
    private readonly directory;
    private readonly threshold;
    constructor(directory: string, threshold: number);
    append(text: string): void;
    /** Persist pending originals before any delivery/retention loss, even below the initial threshold. */
    preserve(): void;
    info(): {
        fullOutputComplete: boolean;
        fullOutputError: string;
    } | {
        fullOutputError?: string;
        fullOutputPath: string;
        fullOutputBytes: number;
        fullOutputComplete: boolean;
        fullOutputAppendOnly: boolean;
    } | undefined;
    close(): void;
}
