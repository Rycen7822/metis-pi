// Config for the Codex appearance UI — rendering never reads the file, invalid values fall back to defaults, the user's file is never rewritten.

export interface AppearanceConfig {
  enabled: boolean;
  thinking: { streaming: "full" | "collapsed"; completed: "collapsed" | "full"; rail: boolean };
  writePreview: { enabled: boolean; rows: number };
  /** Working widget segments. `elapsed:false` removes ONLY the duration —
   * thought/phase/tool/tokens keep updating. */
  working: { elapsed: boolean; thought: boolean; tool: boolean; tokens: boolean };
  /** Footer detail lines. */
  footer: { enabled: boolean; details: boolean; showCache: boolean; showCost: boolean };
  summary: { enabled: boolean; persist: boolean };
}

export const CONFIG_FILE = "codex-appearance.json";

export const DEFAULT_CONFIG: AppearanceConfig = {
  enabled: true,
  thinking: { streaming: "full", completed: "full", rail: true },
  writePreview: { enabled: true, rows: 8 },
  working: { elapsed: true, thought: true, tool: true, tokens: true },
  footer: { enabled: true, details: true, showCache: true, showCost: true },
  summary: { enabled: true, persist: true },
};

const SUMMARY_ENTRY_TYPE = "pi-codex-appearance:interaction-summary:v1";

export interface ConfigLoadResult {
  config: AppearanceConfig;
  /** Human-readable problems with the user's file (empty when pristine/default). */
  problems: string[];
  /** Whether a user file existed at all. */
  present: boolean;
}

function bool(value: unknown, fallback: boolean, problems: string[], where: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  problems.push(`${where}: expected boolean, got ${typeof value} — using ${fallback}`);
  return fallback;
}

export function validateConfig(raw: unknown, problems: string[]): AppearanceConfig {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_CONFIG);
  if (typeof raw !== "object") {
    problems.push("root: expected object — using defaults");
    return structuredClone(DEFAULT_CONFIG);
  }
  const root = raw as Record<string, unknown>;
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.enabled = bool(root.enabled, cfg.enabled, problems, "enabled");

  const thinking = root.thinking;
  if (thinking !== undefined && thinking !== null) {
    if (typeof thinking === "object") {
      const t = thinking as Record<string, unknown>;
      if (t.streaming === "full" || t.streaming === "collapsed") cfg.thinking.streaming = t.streaming;
      else if (t.streaming !== undefined) problems.push(`thinking.streaming: unknown value ${JSON.stringify(t.streaming)} — using "full"`);
      if (t.completed === "collapsed" || t.completed === "full") cfg.thinking.completed = t.completed;
      else if (t.completed !== undefined) problems.push(`thinking.completed: unknown value — using "full"`);
      cfg.thinking.rail = bool(t.rail, cfg.thinking.rail, problems, "thinking.rail");
    } else {
      problems.push("thinking: expected object — using defaults");
    }
  }

  const wp = root.writePreview;
  if (wp !== undefined && wp !== null) {
    if (typeof wp === "object") {
      const w = wp as Record<string, unknown>;
      cfg.writePreview.enabled = bool(w.enabled, cfg.writePreview.enabled, problems, "writePreview.enabled");
      if (w.rows !== undefined && w.rows !== null) {
        if (typeof w.rows === "number" && Number.isFinite(w.rows) && w.rows >= 0 && w.rows <= 64) {
          cfg.writePreview.rows = Math.floor(w.rows);
        } else {
          problems.push("writePreview.rows: expected number 0..64 — using 8");
        }
      }
    } else {
      problems.push("writePreview: expected object — using defaults");
    }
  }

  const working = root.working;
  if (working !== undefined && working !== null) {
    if (typeof working === "object") {
      const w = working as Record<string, unknown>;
      cfg.working.elapsed = bool(w.elapsed, cfg.working.elapsed, problems, "working.elapsed");
      cfg.working.thought = bool(w.thought, cfg.working.thought, problems, "working.thought");
      cfg.working.tool = bool(w.tool, cfg.working.tool, problems, "working.tool");
      cfg.working.tokens = bool(w.tokens, cfg.working.tokens, problems, "working.tokens");
    } else {
      problems.push("working: expected object — using defaults");
    }
  }

  const footer = root.footer;
  if (footer !== undefined && footer !== null) {
    if (typeof footer === "object") {
      const f = footer as Record<string, unknown>;
      cfg.footer.enabled = bool(f.enabled, cfg.footer.enabled, problems, "footer.enabled");
      cfg.footer.details = bool(f.details, cfg.footer.details, problems, "footer.details");
      cfg.footer.showCache = bool(f.showCache, cfg.footer.showCache, problems, "footer.showCache");
      cfg.footer.showCost = bool(f.showCost, cfg.footer.showCost, problems, "footer.showCost");
    } else {
      problems.push("footer: expected object — using defaults");
    }
  }

  const summary = root.summary;
  if (summary !== undefined && summary !== null) {
    if (typeof summary === "object") {
      const s = summary as Record<string, unknown>;
      cfg.summary.enabled = bool(s.enabled, cfg.summary.enabled, problems, "summary.enabled");
      cfg.summary.persist = bool(s.persist, cfg.summary.persist, problems, "summary.persist");
    } else {
      problems.push("summary: expected object — using defaults");
    }
  }

  return cfg;
}

/** Load the config from the agent dir. `readFile` is injectable for tests. */
export function loadConfig(
  agentDir: string | undefined,
  readFile: (path: string) => string | undefined = () => undefined,
): ConfigLoadResult {
  if (!agentDir) return { config: structuredClone(DEFAULT_CONFIG), problems: [], present: false };
  const path = `${agentDir.replace(/\/$/, "")}/${CONFIG_FILE}`;
  let text: string | undefined;
  try {
    text = readFile(path);
  } catch {
    text = undefined;
  }
  if (text === undefined) return { config: structuredClone(DEFAULT_CONFIG), problems: [], present: false };
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { config: structuredClone(DEFAULT_CONFIG), problems: [`JSON parse failed: ${(error as Error).message} — using defaults`], present: true };
  }
  return { config: validateConfig(raw, problems), problems, present: true };
}

export { SUMMARY_ENTRY_TYPE };
