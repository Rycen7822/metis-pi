/** Automatically prepare the managed Linux CPU runtime; successful assets are reused across updates. */
export function ensureSemanticRuntime(agentDir?: string, signal?: AbortSignal): Promise<void>;
