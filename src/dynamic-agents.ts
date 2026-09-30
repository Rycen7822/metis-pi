import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DYNAMIC_AGENTS_STATE = "metis-dynamic-agents";
const GLOBAL_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
export type AgentFile = { path: string; content: string };
export type ModelIdentity = { provider: string; id: string };
export type Policy = { file?: AgentFile; group?: string; notify: boolean; error?: string };
export type Group = { id: string; file: string; include: string[]; exclude: string[] };

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
}

export function parseConfig(value: unknown): { enabled: boolean; notify: boolean; groups: Group[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.groups)) throw new Error("Expected version: 1 and groups array");
  for (const key of ["enabled", "notify"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  const ids = new Set<string>();
  const groups = raw.groups.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid policy group");
    const group = item as Record<string, unknown>;
    if (typeof group.id !== "string" || !group.id.trim() || ids.has(group.id)
      || typeof group.file !== "string" || !group.file.trim()
      || !strings(group.include) || !group.include.length
      || (group.exclude !== undefined && !strings(group.exclude))) throw new Error("Group needs unique id, file, nonempty include and optional exclude arrays");
    ids.add(group.id);
    return { id: group.id, file: group.file, include: group.include, exclude: group.exclude as string[] ?? [] };
  });
  return { enabled: raw.enabled !== false, notify: raw.notify !== false, groups };
}

/** A slash qualifies a provider. Bare patterns also match the last model-ID component. */
export function matches(pattern: string, model: ModelIdentity): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "u");
  return pattern.includes("/") ? regex.test(`${model.provider}/${model.id}`)
    : regex.test(model.id) || regex.test(model.id.slice(model.id.lastIndexOf("/") + 1));
}

export function loadPolicy(configPath: string, model: ModelIdentity | undefined): Policy {
  if (!existsSync(configPath)) return { notify: true };
  try {
    const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")));
    if (!config.enabled || !model) return { notify: config.notify };
    const group = config.groups.find(group => group.include.some(pattern => matches(pattern, model))
      && !group.exclude.some(pattern => matches(pattern, model)));
    if (!group) return { notify: config.notify };
    const path = resolve(dirname(configPath), group.file);
    if (/["\r\n]/.test(path)) throw new Error("Policy path cannot contain quotes or line breaks");
    const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    if (!content.trim()) throw new Error(`Empty policy file: ${path}`);
    return { group: group.id, file: { path, content }, notify: config.notify };
  } catch (error) {
    return { notify: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function globalPaths(agentDir: string): string[] {
  return GLOBAL_NAMES.map(name => join(resolve(agentDir), name));
}

/** Refresh Pi's global-file precedence at a run boundary, without its loader cache. */
export function loadGlobal(agentDir: string): { file?: AgentFile; error?: string } {
  const errors: string[] = [];
  for (const path of globalPaths(agentDir)) {
    try {
      if (!statSync(path).isFile()) continue;
      return { file: { path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") },
        ...(errors.length ? { error: errors.join("; ") } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors.length ? { error: errors.join("; ") } : {};
}

export function replaceGlobal(files: AgentFile[], sources: Set<string>, replacement: AgentFile | undefined): AgentFile[] {
  const output: AgentFile[] = [];
  let inserted = false;
  for (const file of files) {
    if (!sources.has(file.path)) { output.push(file); continue; }
    if (!inserted && replacement) output.push(replacement);
    inserted = true;
  }
  if (!inserted && replacement) output.unshift(replacement);
  return output;
}

/** Pi's source-labelled context blocks; only known global sources are replaced.
 * Match whole blocks up to the next source, so policy text may contain closing tags.
 */
export function projectInstructions(text: string, sources: Set<string>, replacement: AgentFile | undefined): string {
  const block = /^<project_instructions path="([^"\n]+)">\n[\s\S]*?\n<\/project_instructions>(?=\n\n<project_instructions path="|\n<\/project_context>|\s*$)/gm;
  let inserted = false;
  return text.replace(block, (original, path: string) => {
    if (!sources.has(path)) return original;
    if (inserted || !replacement) return "";
    inserted = true;
    return `<project_instructions path="${replacement.path}">\n${replacement.content}\n</project_instructions>`;
  });
}

/** Copy-on-write request projection; never edit source messages or non-system history. */
export function projectMessages<T extends { role: string }>(messages: T[], sources: Set<string>, replacement: AgentFile | undefined): T[] {
  return messages.map(message => {
    if (message.role !== "system") return message;
    const system = message as T & { content?: string; sections?: Record<string, string | null> };
    const content = typeof system.content === "string" ? projectInstructions(system.content, sources, replacement) : system.content;
    const oldSection = system.sections?.project_context;
    const section = typeof oldSection === "string" ? projectInstructions(oldSection, sources, replacement) : oldSection;
    if (content === system.content && section === oldSection) return message;
    return { ...message, ...(content !== system.content ? { content } : {}),
      ...(section !== oldSection ? { sections: { ...system.sections, project_context: section } } : {}) };
  });
}
