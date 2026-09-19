import { type HostMessage } from "./host-protocol.js";
type HostConnectionOptions = {
    binary: string;
    onMessage: (message: HostMessage) => void;
    onFailure: (error: Error) => void;
};
export declare class CodeModeHostConnection {
    private readonly process;
    private readonly onMessage;
    private readonly onFailure;
    private requestId;
    private ready;
    private pending;
    private initial;
    constructor(options: HostConnectionOptions);
    get running(): boolean;
    nextRequestId(): number;
    start(): Promise<void>;
    private startProcess;
    request(request: Record<string, unknown>, onValue?: (value: unknown) => void): Promise<unknown>;
    requestWithId(id: number, request: Record<string, unknown>, onValue?: (value: unknown) => void): Promise<unknown>;
    expectInitial(id: number): Promise<unknown>;
    send(message: unknown): void;
    rejectOperation(id: number, error: Error): void;
    close(error: Error): void;
    private handleMessage;
    private failAll;
}
export {};
