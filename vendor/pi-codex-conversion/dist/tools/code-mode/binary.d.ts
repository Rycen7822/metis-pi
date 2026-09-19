import { type InstallCodeModeHostOptions } from "./install-host.ts";
interface CodeModeHostBinaryRuntime {
    platform: string;
    arch: string;
    packageRoot: string;
    agentDir: string;
    install(options: InstallCodeModeHostOptions): Promise<void>;
}
export declare function codeModeHostBinaryPath(overrides?: Partial<CodeModeHostBinaryRuntime>): string;
export declare function ensureCodeModeHostBinary(signal?: AbortSignal, overrides?: Partial<CodeModeHostBinaryRuntime>): Promise<string>;
export {};
