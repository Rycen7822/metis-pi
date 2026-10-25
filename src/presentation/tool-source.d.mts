export const OWNED_EXECUTION_ENTRY: string;
export const OWNED_FUSION_ENTRY: string;
export const OWNED_NEURAL_SEARCH_ENTRY: string;
export const OWNED_SUBAGENTS_ENTRY: string;
export type ToolPresentation = "builtin" | "fusion" | "execution" | "neural" | "fff" | "subagents";
export function toolPresentation(name: string, info: unknown): ToolPresentation | undefined;
