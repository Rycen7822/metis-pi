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

export function languageForPath(filePath: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(filePath);
  if (!match) return undefined;
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", md: "markdown", json: "json",
    sh: "bash", bash: "bash", ps1: "powershell", yaml: "yaml", yml: "yaml",
    toml: "toml", css: "css", html: "html", rb: "ruby", java: "java", c: "c",
    h: "c", cpp: "cpp", hpp: "cpp", sql: "sql",
  };
  return map[match[1]!.toLowerCase()];
}
