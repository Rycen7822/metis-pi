import type { HostMessage } from "./host-protocol.js";
type HostSessionOptions = {
    binary: string;
    shutdownGraceMs?: number | undefined;
    onMessage: (message: HostMessage) => void;
    onFailure: (error: Error) => void;
};
export declare class CodeModeHostSession {
    readonly id: `${string}-${string}-${string}-${string}-${string}`;
    private readonly connection;
    private readonly shutdownGraceMs;
    private readonly onFailure;
    private ready;
    constructor(options: HostSessionOptions);
    start(): Promise<void>;
    private startSession;
    nextRequestId(): number;
    expectInitial(id: number): Promise<unknown>;
    requestWithId(id: number, request: Record<string, unknown>, onValue?: (value: unknown) => void): Promise<unknown>;
    send(message: unknown): void;
    rejectOperation(id: number, error: Error): void;
    shutdown(): Promise<void>;
}
export {};
