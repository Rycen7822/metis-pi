export declare const REALTIME_SYSTEM_PROMPT_BASENAME = "REALTIME-SYSTEM-PROMPT.md";
export interface CodexVoiceSystemPromptStatus {
    created: boolean;
    schemaVersion?: number;
    currentSchemaVersion: number;
    current: boolean;
}
export declare function getCodexVoiceSystemPromptPath(agentDir?: string): string;
export declare function getProjectCodexVoiceSystemPromptPath(cwd: string): string;
export declare function getPackagedCodexVoiceSystemPromptPath(): string;
export declare function getCodexVoiceSystemPromptChangelogPath(): string;
export declare function prepareCodexVoiceSystemPrompt(promptPath?: string, templatePath?: string): CodexVoiceSystemPromptStatus;
export declare function formatCodexVoicePromptSchemaMismatch(currentSchemaVersion: number, promptPath?: string, changelogPath?: string): string;
export declare function loadCodexVoiceSystemPrompt(promptPath?: string, projectPromptPath?: string): string;
