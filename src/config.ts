// Config for the Codex appearance UI — rendering never reads the file, invalid values fall back to defaults, the user's file is never rewritten.

export interface AppearanceConfig {
  enabled: boolean;
  thinking: { streaming: "peek" | "full" | "collapsed"; completed: "collapsed" | "full"; rail: boolean; peekLines: number };
  writePreview: { enabled: boolean; rows: number };
  /** Composer surface (gray background, `> ` prefix, metadata row). */
  composer: { surface: boolean; promptPrefix: boolean; metadata: boolean };
  /** Working widget segments + animation. `elapsed:false` removes ONLY the
   * duration — thought/tool keep updating. */
  working: { elapsed: boolean; thought: boolean; tool: boolean; tokens: boolean; animation: boolean; animationIntervalMs: number };
  /** Footer detail lines. */
  footer: { enabled: boolean; details: boolean; showCache: boolean; showChanges: boolean; showSpeed: boolean };
  summary: { enabled: boolean; persist: boolean };
  /** Selection copy (fullscreen TUI). Ctrl+C copies the selection instead of
   * clearing the editor; no selection keeps stock behavior. */
  selectionCopy: { enabled: boolean; ctrlC: boolean };
  /** Fullscreen side gutters; marginX 0 disables, gutters vanish below minWidth. */
  fullscreen: { marginX: number; minWidth: number };
  /** Glyph presentation: append U+FE0E (text presentation) to emoji-presentation
   * marks in rendered frames, so a terminal's emoji font cannot draw them ~2
   * cells wide over the next character. Display-only; `include` adds marks. */
  glyphs: { textPresentation: boolean; include: string[] };
}

const CONFIG_FILE = "metis-pi.json";

export const DEFAULT_CONFIG: AppearanceConfig = {
  enabled: true,
  thinking: { streaming: "peek", completed: "collapsed", rail: true, peekLines: 6 },
  writePreview: { enabled: true, rows: 8 },
  composer: { surface: true, promptPrefix: true, metadata: true },
  working: { elapsed: true, thought: true, tool: true, tokens: false, animation: true, animationIntervalMs: 32 },
  footer: { enabled: true, details: true, showCache: true, showChanges: true, showSpeed: true },
  summary: { enabled: true, persist: true },
  selectionCopy: { enabled: true, ctrlC: true },
  fullscreen: { marginX: 2, minWidth: 72 },
  glyphs: { textPresentation: true, include: [] },
};

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

function validateConfig(raw: unknown, problems: string[]): AppearanceConfig {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_CONFIG);
  if (typeof raw !== "object") {
    problems.push("root: expected object — using defaults");
    return structuredClone(DEFAULT_CONFIG);
  }
  const root = raw as Record<string, unknown>;
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.enabled = bool(root.enabled, cfg.enabled, problems, "enabled");

  // Missing sections are empty overrides. Preserve the loader's permissive object
  // handling (including arrays); only known fields can change the cloned defaults.
  const section = (key: string): Record<string, unknown> => {
    const value = root[key];
    if (value === undefined || value === null) return {};
    if (typeof value === "object") return value as Record<string, unknown>;
    problems.push(`${key}: expected object — using defaults`);
    return {};
  };
  const booleans = (target: object, source: Record<string, unknown>, prefix: string): void => {
    const fields = target as Record<string, unknown>;
    for (const [key, fallback] of Object.entries(fields)) {
      if (typeof fallback === "boolean") fields[key] = bool(source[key], fallback, problems, `${prefix}.${key}`);
    }
  };
  const integer = (value: unknown, fallback: number, where: string, min: number, max: number, clamp = false): number => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && (clamp || (value >= min && value <= max))) {
      return Math.max(min, Math.min(max, Math.floor(value)));
    }
    problems.push(`${where}: expected number ${min}..${max} — using ${fallback}`);
    return fallback;
  };

  const thinking = section("thinking");
  if (thinking.streaming === "peek" || thinking.streaming === "full" || thinking.streaming === "collapsed") cfg.thinking.streaming = thinking.streaming;
  else if (thinking.streaming !== undefined) problems.push(`thinking.streaming: unknown value ${JSON.stringify(thinking.streaming)} — using "peek"`);
  if (thinking.completed === "collapsed" || thinking.completed === "full") cfg.thinking.completed = thinking.completed;
  else if (thinking.completed !== undefined) problems.push(`thinking.completed: unknown value — using "${cfg.thinking.completed}"`);
  booleans(cfg.thinking, thinking, "thinking");
  cfg.thinking.peekLines = integer(thinking.peekLines, cfg.thinking.peekLines, "thinking.peekLines", 1, 40, true);

  const wp = section("writePreview");
  booleans(cfg.writePreview, wp, "writePreview");
  cfg.writePreview.rows = integer(wp.rows, cfg.writePreview.rows, "writePreview.rows", 0, 64);

  const glyphs = section("glyphs");
  booleans(cfg.glyphs, glyphs, "glyphs");
  const include = glyphs.include;
  if (Array.isArray(include)) {
    for (const entry of include) {
      if (typeof entry !== "string") {
        problems.push("glyphs.include: entries must be single-character strings — skipped");
        continue;
      }
      const cp = entry.codePointAt(0);
      const size = cp !== undefined && cp > 0xffff ? 2 : 1;
      if (cp === undefined || cp < 0x80 || entry.length !== size) {
        problems.push(`glyphs.include: ${JSON.stringify(entry)} is not a single non-ASCII character — skipped`);
        continue;
      }
      if (cfg.glyphs.include.length >= 32) {
        problems.push("glyphs.include: at most 32 entries — extra entries ignored");
        break;
      }
      if (!cfg.glyphs.include.includes(entry)) cfg.glyphs.include.push(entry);
    }
  } else if (include !== undefined && include !== null) {
    problems.push("glyphs.include: expected an array of characters — using none");
  }

  booleans(cfg.composer, section("composer"), "composer");
  const working = section("working");
  booleans(cfg.working, working, "working");
  cfg.working.animationIntervalMs = integer(working.animationIntervalMs, cfg.working.animationIntervalMs, "working.animationIntervalMs", 32, 1000, true);

  booleans(cfg.footer, section("footer"), "footer");
  booleans(cfg.summary, section("summary"), "summary");
  booleans(cfg.selectionCopy, section("selectionCopy"), "selectionCopy");
  const fullscreen = section("fullscreen");
  cfg.fullscreen.marginX = integer(fullscreen.marginX, cfg.fullscreen.marginX, "fullscreen.marginX", 0, 8);
  cfg.fullscreen.minWidth = integer(fullscreen.minWidth, cfg.fullscreen.minWidth, "fullscreen.minWidth", 40, 400);

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
