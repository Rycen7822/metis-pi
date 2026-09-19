export declare class JupyterSocket {
    private socket;
    private reader;
    private buffered;
    private readonly stopped;
    private ready;
    private readonly type;
    private readonly port;
    constructor(type: "DEALER" | "SUB", port: number);
    connect(signal?: AbortSignal): Promise<void>;
    send(frames: readonly Buffer[]): Promise<void>;
    [Symbol.asyncIterator](): AsyncGenerator<Buffer[]>;
    close(): void;
    private read;
    private readFrame;
    private write;
}
