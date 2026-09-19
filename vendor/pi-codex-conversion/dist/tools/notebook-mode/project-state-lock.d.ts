export declare function withProjectStateLock<T>(path: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
