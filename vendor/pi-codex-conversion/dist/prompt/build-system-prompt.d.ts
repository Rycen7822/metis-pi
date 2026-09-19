export interface PromptSkill {
    name: string;
    description: string;
    filePath: string;
}
export interface StructuredPromptSkill {
    name: string;
    description: string;
    filePath: string;
    disableModelInvocation?: boolean | undefined;
}
export interface PiSystemPromptOptions {
    customPrompt?: string | undefined;
    selectedTools?: string[] | undefined;
    toolSnippets?: Record<string, string> | undefined;
    promptGuidelines?: string[] | undefined;
    appendSystemPrompt?: string | undefined;
    cwd: string;
    contextFiles?: Array<{
        path: string;
        content: string;
    }> | undefined;
}
type CodexPromptMode = "normal" | "code" | "notebook";
export declare function extractPiPromptSkills(prompt: string): PromptSkill[];
export declare function promptSkillsFromStructuredSkills(skills: readonly StructuredPromptSkill[] | undefined): PromptSkill[];
export declare function resolvePromptSkills(structuredSkills: readonly StructuredPromptSkill[] | undefined, fallbackSkills: readonly PromptSkill[]): PromptSkill[];
export declare function buildCodexSystemPrompt(basePrompt: string, options?: {
    skills?: PromptSkill[] | undefined;
    shell?: string | undefined;
    mode?: CodexPromptMode | undefined;
    heavySystemPromptOverwrite?: boolean | undefined;
    systemPromptOptions?: PiSystemPromptOptions | undefined;
}): string;
export {};
