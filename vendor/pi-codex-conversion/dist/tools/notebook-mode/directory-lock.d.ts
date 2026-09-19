export interface DirectoryLock {
    release(): void;
}
export declare function acquireDirectoryLock(path: string, options: {
    waitMs: number;
    staleMs: number;
    pollMs: number;
    signal?: AbortSignal | undefined;
    stopWaiting?: (() => boolean) | undefined;
}): Promise<DirectoryLock | undefined>;
