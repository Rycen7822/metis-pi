export declare const CODEX_RESERVE_MODEL = "gpt-reserve";
export interface CodexReserveStatus {
    accountKey: string;
    entryAllowed: boolean;
    ordinaryUsageRecovered: boolean;
}
export declare function parseCodexReserveStatus(payload: unknown, identity: {
    accountId: string;
    userId: string;
}, modelId: string): CodexReserveStatus | undefined;
