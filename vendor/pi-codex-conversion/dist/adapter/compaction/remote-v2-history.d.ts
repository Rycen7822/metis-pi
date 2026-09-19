export declare function canonicalCompactionOutput(item: unknown): Record<string, unknown> | undefined;
export declare function normalizeRemoteCompactionV2PromptInput(input: readonly unknown[]): Record<string, unknown>[];
export declare function buildRemoteCompactionV2Window(promptInput: readonly unknown[], compactionOutput: Record<string, unknown>, maxTokens?: number): Record<string, unknown>[];
