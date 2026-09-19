export type OAuthDeviceCodePollResult<T> = {
    status: "pending";
} | {
    status: "slow_down";
    intervalSeconds?: number;
} | {
    status: "failed";
    message: string;
} | {
    status: "complete";
    value: T;
};
type OAuthDeviceCodePollOptions<T> = {
    intervalSeconds?: number;
    expiresInSeconds?: number;
    waitBeforeFirstPoll?: boolean;
    poll: () => Promise<OAuthDeviceCodePollResult<T>>;
    signal?: AbortSignal;
};
export declare function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodePollOptions<T>): Promise<T>;
export {};
