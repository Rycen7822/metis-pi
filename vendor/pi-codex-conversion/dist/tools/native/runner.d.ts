export interface RunBundledToolOptions {
    binary: string;
    args: string[];
    stdin?: string | undefined;
    cwd: string;
    env?: NodeJS.ProcessEnv | undefined;
    maxBuffer?: number | undefined;
    signal?: AbortSignal | undefined;
    label?: string | undefined;
}
export interface BundledToolResult {
    stdout: string;
    stderr: string;
    status: number | null;
}
export declare function runBundledTool({ binary, args, stdin, cwd, env, maxBuffer, signal, label }: RunBundledToolOptions): Promise<BundledToolResult>;
export declare function parseSingleJsonLine<T>(stdout: string, label: string): T;
