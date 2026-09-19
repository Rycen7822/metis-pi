export interface DenoBinaryRuntime {
    platform: string;
    arch: string;
    agentDir: string;
}
export declare function ensureNotebookDenoBinary(overrides: Partial<Omit<DenoBinaryRuntime, "agentDir">> & Pick<DenoBinaryRuntime, "agentDir">, signal?: AbortSignal): Promise<string>;
