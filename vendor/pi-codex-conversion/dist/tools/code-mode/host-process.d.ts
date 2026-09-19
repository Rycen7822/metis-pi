type HostProcessOptions = {
    binary: string;
    onMessage: (message: unknown) => void;
    onFailure: (error: Error) => void;
};
export declare class CodeModeHostProcess {
    private readonly binary;
    private readonly onMessage;
    private readonly onFailure;
    private child;
    private buffer;
    private stderr;
    private queuedWriteBytes;
    constructor(options: HostProcessOptions);
    get running(): boolean;
    start(): void;
    send(message: unknown): void;
    kill(): void;
    private onData;
}
export {};
