// Config for the Codex appearance UI — rendering never reads the file, invalid values fall back to defaults, the user's file is never rewritten.

export interface AppearanceConfig {
  enabled: boolean;
  thinking: { streaming: "full" | "collapsed"; completed: "collapsed" | "full"; rail: boolean };
  writePreview: { enabled: boolean; rows: number };
  /** Composer surface (gray background, `> ` prefix, metadata row). */
  composer: { surface: boolean; promptPrefix: boolean; metadata: boolean };
  /** Working widget segments + animation. `elapsed:false` removes ONLY the
   * duration — thought/tool keep updating. */
  working: { elapsed: boolean; thought: boolean; tool: boolean; tokens: boolean; animation: boolean; animationIntervalMs: number };
  /** Footer detail lines. */
  footer: { enabled: boolean; details: boolean; showCache: boolean; showCacheReadWrite: boolean; showCost: boolean; showCodexQuota: boolean; showSpeed: boolean };
  /** Codex quota source (read-only app-server). */
  quota: { codex: "auto" | "on" | "off"; refreshSeconds: number; timeoutMs: number };
  summary: { enabled: boolean; persist: boolean };
  /** Selection copy (fullscreen TUI). Ctrl+C copies the selection instead of
   * clearing the editor; no selection keeps stock behavior. */
  selectionCopy: { enabled: boolean; ctrlC: boolean };
  /** Fullscreen side gutters; marginX 0 disables, gutters vanish below minWidth. */
  fullscreen: { marginX: number; minWidth: number };
}

export const CONFIG_FILE = "codex-appearance.json";

export const DEFAULT_CONFIG: AppearanceConfig = {
  enabled: true,
  thinking: { streaming: "full", completed: "collapsed", rail: true },
  writePreview: { enabled: true, rows: 8 },
  composer: { surface: true, promptPrefix: true, metadata: true },
  working: { elapsed: true, thought: true, tool: true, tokens: false, animation: true, animationIntervalMs: 32 },
  footer: { enabled: true, details: true, showCache: true, showCacheReadWrite: true, showCost: true, showCodexQuota: true, showSpeed: true },
  quota: { codex: "auto", refreshSeconds: 120, timeoutMs: 8000 },
  summary: { enabled: true, persist: true },
  selectionCopy: { enabled: true, ctrlC: true },
  fullscreen: { marginX: 2, minWidth: 72 },
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

  const composer = root.composer;
  if (composer !== undefined && composer !== null) {
    if (typeof composer === "object") {
      const c = composer as Record<string, unknown>;
      cfg.composer.surface = bool(c.surface, cfg.composer.surface, problems, "composer.surface");
      cfg.composer.promptPrefix = bool(c.promptPrefix, cfg.composer.promptPrefix, problems, "composer.promptPrefix");
      cfg.composer.metadata = bool(c.metadata, cfg.composer.metadata, problems, "composer.metadata");
    } else {
      problems.push("composer: expected object — using defaults");
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
      cfg.working.animation = bool(w.animation, cfg.working.animation, problems, "working.animation");
      if (w.animationIntervalMs !== undefined && w.animationIntervalMs !== null) {
        if (typeof w.animationIntervalMs === "number" && Number.isFinite(w.animationIntervalMs)) {
          cfg.working.animationIntervalMs = Math.max(32, Math.min(1000, Math.floor(w.animationIntervalMs)));
        } else {
          problems.push("working.animationIntervalMs: expected number 32..1000 — using 32");
        }
      }
    } else {
      problems.push("working: expected object — using defaults");
    }
  }

  const quota = root.quota;
  if (quota !== undefined && quota !== null) {
    if (typeof quota === "object") {
      const q = quota as Record<string, unknown>;
      if (q.codex === "auto" || q.codex === "on" || q.codex === "off") cfg.quota.codex = q.codex;
      else if (q.codex !== undefined) problems.push(`quota.codex: unknown value ${JSON.stringify(q.codex)} — using "auto"`);
      if (q.refreshSeconds !== undefined && q.refreshSeconds !== null) {
        if (typeof q.refreshSeconds === "number" && Number.isFinite(q.refreshSeconds) && q.refreshSeconds >= 30 && q.refreshSeconds <= 3600) {
          cfg.quota.refreshSeconds = Math.floor(q.refreshSeconds);
        } else {
          problems.push("quota.refreshSeconds: expected number 30..3600 — using 120");
        }
      }
      if (q.timeoutMs !== undefined && q.timeoutMs !== null) {
        if (typeof q.timeoutMs === "number" && Number.isFinite(q.timeoutMs) && q.timeoutMs >= 1000 && q.timeoutMs <= 60000) {
          cfg.quota.timeoutMs = Math.floor(q.timeoutMs);
        } else {
          problems.push("quota.timeoutMs: expected number 1000..60000 — using 8000");
        }
      }
    } else {
      problems.push("quota: expected object — using defaults");
    }
  }

  const footer = root.footer;
  if (footer !== undefined && footer !== null) {
    if (typeof footer === "object") {
      const f = footer as Record<string, unknown>;
      cfg.footer.enabled = bool(f.enabled, cfg.footer.enabled, problems, "footer.enabled");
      cfg.footer.details = bool(f.details, cfg.footer.details, problems, "footer.details");
      cfg.footer.showCache = bool(f.showCache, cfg.footer.showCache, problems, "footer.showCache");
      cfg.footer.showCacheReadWrite = bool(f.showCacheReadWrite, cfg.footer.showCacheReadWrite, problems, "footer.showCacheReadWrite");
      cfg.footer.showCost = bool(f.showCost, cfg.footer.showCost, problems, "footer.showCost");
      cfg.footer.showCodexQuota = bool(f.showCodexQuota, cfg.footer.showCodexQuota, problems, "footer.showCodexQuota");
      cfg.footer.showSpeed = bool(f.showSpeed, cfg.footer.showSpeed, problems, "footer.showSpeed");
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

  const selectionCopy = root.selectionCopy;
  if (selectionCopy !== undefined && selectionCopy !== null) {
    if (typeof selectionCopy === "object") {
      const sc = selectionCopy as Record<string, unknown>;
      cfg.selectionCopy.enabled = bool(sc.enabled, cfg.selectionCopy.enabled, problems, "selectionCopy.enabled");
      cfg.selectionCopy.ctrlC = bool(sc.ctrlC, cfg.selectionCopy.ctrlC, problems, "selectionCopy.ctrlC");
    } else {
      problems.push("selectionCopy: expected object — using defaults");
    }
  }

  const fullscreen = root.fullscreen;
  if (fullscreen !== undefined && fullscreen !== null) {
    if (typeof fullscreen === "object") {
      const fs = fullscreen as Record<string, unknown>;
      if (fs.marginX !== undefined && fs.marginX !== null) {
        if (typeof fs.marginX === "number" && Number.isFinite(fs.marginX) && fs.marginX >= 0 && fs.marginX <= 8) {
          cfg.fullscreen.marginX = Math.floor(fs.marginX);
        } else {
          problems.push("fullscreen.marginX: expected number 0..8 — using 2");
        }
      }
      if (fs.minWidth !== undefined && fs.minWidth !== null) {
        if (typeof fs.minWidth === "number" && Number.isFinite(fs.minWidth) && fs.minWidth >= 40 && fs.minWidth <= 400) {
          cfg.fullscreen.minWidth = Math.floor(fs.minWidth);
        } else {
          problems.push("fullscreen.minWidth: expected number 40..400 — using 72");
        }
      }
    } else {
      problems.push("fullscreen: expected object — using defaults");
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
