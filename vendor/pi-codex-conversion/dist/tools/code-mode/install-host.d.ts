export interface InstallCodeModeHostOptions {
    destination: string;
    platform: string;
    arch: string;
    signal?: AbortSignal | undefined;
}
export declare function installCodeModeHost(options: InstallCodeModeHostOptions): Promise<void>;
