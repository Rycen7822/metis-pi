import { type CodexConversionConfig, type LunaCacheKeepaliveMinutes } from "./config.ts";
export declare const CODEX_CONVERSION_CONFIG_BASENAME = "pi-codex-conversion.json";
export interface EffectiveCodexConversionConfigOptions {
    cwd: string;
    projectTrusted: boolean;
    globalConfigPath?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}
export type CodexConversionConfigScope = "global" | "folder";
export declare function getCodexConversionConfigPath(agentDir?: string): string;
export declare function getProjectCodexConversionConfigPath(cwd: string): string;
export declare function readCodexConversionConfig(configPath?: string): CodexConversionConfig;
export declare function readProjectCodexConversionDocument(cwd: string, projectTrusted: boolean): Record<string, unknown> | undefined;
export declare function hasFolderCodexConversionConfig(cwd: string, projectTrusted: boolean): boolean;
export declare function readEffectiveCodexConversionConfig(options: EffectiveCodexConversionConfigOptions): CodexConversionConfig;
export declare function readLayeredCodexConversionConfig(options: Omit<EffectiveCodexConversionConfigOptions, "env">): CodexConversionConfig;
export declare function setProjectCodexCacheKeepalive(cwd: string, projectTrusted: boolean, enabled: boolean): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function setGlobalCodexLunaCacheKeepalive(minutes: LunaCacheKeepaliveMinutes, globalConfigPath?: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function materializeFolderCodexConversionConfig(cwd: string, projectTrusted: boolean, globalConfigPath?: string | undefined): {
    ok: true;
    config: CodexConversionConfig;
} | {
    ok: false;
    error: string;
};
export declare function clearFolderCodexConversionConfig(cwd: string, projectTrusted: boolean): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function writeCodexConversionConfig(config: CodexConversionConfig, configPath?: string, folderScope?: boolean): {
    ok: true;
} | {
    ok: false;
    error: string;
};
