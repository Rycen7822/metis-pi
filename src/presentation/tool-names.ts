export const TOOL_NAMES = ["bash", "powershell", "read", "grep", "find", "ls", "edit", "write", "ffgrep", "fffind", "neural_search"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type RecordValue = Readonly<Record<string, unknown>>;

export const EXPLORATION_VERBS = { read: "Read", grep: "Search", find: "Find", ls: "List", ffgrep: "Search", fffind: "Find", neural_search: "Search" } as const;
export function isExplorationTool(name: string, args?: unknown): boolean {
  const action = asRecord(args).action;
  return Object.hasOwn(EXPLORATION_VERBS, name) && (name !== "neural_search" ||
    action === "find" || action === "grep" || action === "multi_grep");
}

export function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
