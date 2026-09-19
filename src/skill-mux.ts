// skill-mux — expand MULTIPLE leading `/skill:name` tokens in one user input.
//
// The host natively expands a single `/skill:name args` (agent-session
// `_expandSkillCommand`), but only the first token — a second `/skill:` is
// silently swallowed as "args". This module restores the intuitive syntax
//
//     /skill:one /skill:two the rest of the message
//
// by registering on pi's official `input` event (fired BEFORE the host's
// skill/template expansion; a transform result replaces the text that is
// then sent). Exactly ONE skill keeps flowing to the host unchanged; zero
// skills is ignored in O(1). Expansion output is byte-identical to the host
// format so the model cannot tell the difference.
//
// Performance notes (the input hook runs on every submitted message):
// - Fast path is a single startsWith check; no I/O, no regex.
// - The name→skill index is built lazily ONCE per session and reused; a name
//   miss triggers a single rebuild that additionally sweeps extension
//   manifests, and the miss is remembered so it never re-scans.
// - Skill bodies are read per expansion (expansions are user-driven, rare).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkills, stripFrontmatter, type InputEvent, type InputEventResult, type Skill } from "@earendil-works/pi-coding-agent";

/** Leading `/skill:name` token: name runs to the next whitespace (or EOL). */
const SKILL_TOKEN = /^\/skill:([^\s]+)(\s+|$)/;

export interface SkillMuxOptions {
  /** Agent config dir (default ~/.pi/agent). */
  agentDir?: string;
  /** Working directory for project-local skills (default process.cwd()). */
  cwd?: string;
}

export interface SkillMuxStats {
  /** How many times the skill index was (re)built. */
  builds: number;
  /** Names that stayed unknown after a full rebuild (negative cache size). */
  misses: number;
}

export interface SkillMux {
  /** pi.on("input") handler: transform multi-skill input, continue otherwise. */
  onInput(event: InputEvent): InputEventResult;
  /** Expand a text for tests; null means "no transform" (host handles it). */
  expand(text: string): string | null;
  stats(): SkillMuxStats;
}

export function createSkillMux(options?: SkillMuxOptions): SkillMux {
  const agentDir = resolve(options?.agentDir ?? join(homedir(), ".pi", "agent"));
  const cwd = resolve(options?.cwd ?? process.cwd());

  let index: Map<string, Skill> | null = null;
  const misses = new Set<string>();
  let builds = 0;

  // ---- index construction ---------------------------------------------------

  /** Skills declared in settings files (the host's primary registry). */
  const settingsSkillPaths = (): string[] => {
    const files = [
      join(agentDir, "settings.json"),
      join(cwd, ".pi", "settings.json"),
      join(cwd, ".pi", "settings.local.json"),
    ];
    const paths: string[] = [];
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        continue; // missing or malformed settings: same tolerance as the host
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const skills = (parsed as { skills?: unknown }).skills;
      if (!Array.isArray(skills)) continue;
      for (const entry of skills) {
        let raw: unknown = entry;
        if (typeof entry === "object" && entry !== null) {
          const e = entry as { path?: unknown; enabled?: unknown };
          if (e.enabled === false) continue;
          raw = e.path;
        }
        if (typeof raw !== "string" || raw.length === 0) continue;
        const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(join(file, ".."), raw);
        if (existsSync(expanded)) paths.push(expanded);
      }
    }
    return paths;
  };

  /** Skills declared by installed extension packages (package.json pi.skills). */
  const extensionSkillPaths = (): string[] => {
    const roots = [join(agentDir, "extensions"), join(agentDir, "git")];
    const packageDirs: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth < 0) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = join(dir, entry.name);
        if (existsSync(join(full, "package.json"))) packageDirs.push(full);
        else walk(full, depth - 1);
      }
    };
    // ~/.pi/agent/extensions/<pkg>/package.json and
    // ~/.pi/agent/git/<host>/<org>/<repo>/package.json — bounded depth.
    for (const root of roots) walk(root, root.endsWith("git") ? 2 : 0);
    const paths: string[] = [];
    for (const dir of packageDirs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      } catch {
        continue;
      }
      const declared = (parsed as { pi?: { skills?: unknown } })?.pi?.skills;
      if (!Array.isArray(declared)) continue;
      for (const entry of declared) {
        if (typeof entry !== "string" || entry.length === 0) continue;
        const full = resolve(dir, entry);
        if (existsSync(full)) paths.push(full);
      }
    }
    return paths;
  };

  const buildIndex = (includeExtensions: boolean): void => {
    builds += 1;
    const skillPaths = [...settingsSkillPaths(), ...(includeExtensions ? extensionSkillPaths() : [])];
    // The host's own loader: identical discovery, collision, and validation
    // semantics to what `/skill:name` single expansion resolves against.
    const result = loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true });
    index = new Map(result.skills.map((skill) => [skill.name, skill]));
  };

  const lookup = (name: string): Skill | undefined => {
    if (!index) buildIndex(false);
    let skill = index!.get(name);
    if (!skill && !misses.has(name)) {
      // First miss: maybe a skill that is only declared via an extension
      // manifest — one rebuild with the sweep, then remember the miss.
      buildIndex(true);
      skill = index!.get(name);
      if (!skill) misses.add(name);
    }
    return skill;
  };

  // ---- expansion ------------------------------------------------------------

  const expandSkillBlock = (skill: Skill): string | null => {
    try {
      const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
      // Byte-identical to the host's _expandSkillCommand output.
      return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    } catch {
      return null; // unreadable file: keep the token literal, like the host
    }
  };

  const expand = (text: string): string | null => {
    if (!text.startsWith("/skill:")) return null; // O(1) fast path
    const names: string[] = [];
    let rest = text;
    let match: RegExpExecArray | null;
    while ((match = SKILL_TOKEN.exec(rest)) !== null) {
      names.push(match[1]);
      rest = rest.slice(match[0].length);
    }
    if (names.length < 2) return null; // 0 impossible; 1 = the host's native job
    const parts: string[] = [];
    for (const name of names) {
      const skill = lookup(name);
      const block = skill ? expandSkillBlock(skill) : null;
      // Unknown/unreadable skill stays a literal token (host semantics).
      parts.push(block ?? `/skill:${name}`);
    }
    const tail = rest.trim();
    if (tail) parts.push(tail);
    return parts.join("\n\n");
  };

  return {
    expand,
    stats: () => ({ builds, misses: misses.size }),
    onInput(event) {
      const text = expand(event.text);
      if (text === null) return { action: "continue" };
      const images = event.images;
      return images && images.length > 0 ? { action: "transform", text, images } : { action: "transform", text };
    },
  };
}
