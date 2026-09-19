export declare function nativeBinaryRecoveryMessage(helper: string, error: unknown, options?: {
    binaryPath?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    startupWriteFailure?: boolean | undefined;
}): string | undefined;
export declare function formatNativeBinaryError(helper: string, error: unknown, options?: {
    binaryPath?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    startupWriteFailure?: boolean | undefined;
}): string;
