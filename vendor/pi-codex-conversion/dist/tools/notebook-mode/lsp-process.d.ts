export declare class OneShotLspProcess {
    private readonly child;
    private readonly pending;
    private nextId;
    private input;
    private stderr;
    private stopped;
    constructor(options: {
        deno: string;
        cwd: string;
        signal: AbortSignal;
    });
    request(method: string, params?: unknown): Promise<unknown>;
    notify(method: string, params?: unknown): void;
    shutdown(): Promise<void>;
    private send;
    private receive;
    private readMessage;
    private handle;
    private answerServerRequest;
    private fail;
    private rejectPending;
}
