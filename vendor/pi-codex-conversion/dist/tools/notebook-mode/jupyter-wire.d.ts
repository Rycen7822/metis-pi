export interface JupyterMessage {
    header: {
        msg_id: string;
        session: string;
        username: string;
        date: string;
        msg_type: string;
        version: string;
    };
    parent_header: Record<string, unknown>;
    metadata: Record<string, unknown>;
    content: Record<string, unknown>;
}
export declare function createJupyterMessage(type: string, content: Record<string, unknown>, session: string): JupyterMessage;
export declare function encodeJupyterMessage(message: JupyterMessage, key: string): Buffer[];
export declare function decodeJupyterMessage(frames: Buffer[], key: string): JupyterMessage | undefined;
