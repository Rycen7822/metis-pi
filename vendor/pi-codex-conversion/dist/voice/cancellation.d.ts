export declare const CANCELLED: unique symbol;
export declare function interruptible<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T | typeof CANCELLED>;
