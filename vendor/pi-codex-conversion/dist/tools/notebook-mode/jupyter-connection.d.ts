export interface JupyterConnectionInfo {
    ip: "127.0.0.1";
    transport: "tcp";
    shell_port: number;
    iopub_port: number;
    stdin_port: number;
    control_port: number;
    hb_port: number;
    signature_scheme: "hmac-sha256";
    key: string;
    kernel_name: "deno";
}
export declare function createJupyterConnectionFile(): Promise<{
    info: JupyterConnectionInfo;
    path: string;
    dir: string;
}>;
