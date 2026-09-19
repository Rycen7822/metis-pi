export declare const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
export interface CodexTurnState {
    current(): string | undefined;
    capture(value: string | null | undefined): void;
    capturePrewarm(value: string | null | undefined): void;
    beginTurn(): void;
    reset(): void;
}
export declare function withCodexTurnState<T extends {
    client_metadata?: Record<string, unknown> | undefined;
}>(body: T, turnState: CodexTurnState | undefined): T;
export declare function withCodexTurnStateHeader(headers: Headers, turnState: CodexTurnState | undefined): Headers;
export declare function createCodexTurnState(): CodexTurnState;
export declare function extractCodexTurnStateFromWebSocketEvent(event: unknown): string | undefined;
