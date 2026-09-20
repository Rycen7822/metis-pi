// Catppuccin Mocha syntax palette aligned with openai/codex main; presentation-only constants.

export interface Rgb { readonly r: number; readonly g: number; readonly b: number }

/** Catppuccin Mocha foregrounds used by Codex's bash/diff highlighting. */
export const MOCHA = {
  base: "#cdd6f4",
  function: "#89b4fa",
  keyword: "#cba6f7",
  string: "#a6e3a1",
  number: "#fab387",
  operator: "#89b4fa",
  parameter: "#eba0ac",
  builtin: "#f38ba8",
  punctuation: "#9399b2",
  comment: "#9399b2",
} as const;

export type MochaToken = keyof typeof MOCHA;

/** Codex accent cyan ("Read".cyan()) — the one definition for the composer
 * prefix, the thinking rail, the editor caret painter, and exploration verbs. */
export const CODEX_CYAN = "#3a96dd";
/** CODEX_CYAN pre-expanded, for raw SGR strings that bypass foregroundAnsi. */
export const CODEX_CYAN_RGB = "58;150;221";

/** Codex diff dark surfaces (exec_cell/diff_render.rs). */
export const DIFF_ADD_BG: Rgb = { r: 33, g: 58, b: 43 };   // #213A2B
export const DIFF_DEL_BG: Rgb = { r: 74, g: 34, b: 29 };   // #4A221D
/** ANSI-256 fallback indexes for the same surfaces (diff_render.rs). */
export const DIFF_ADD_BG_256 = 22;
export const DIFF_DEL_BG_256 = 52;

export type ColorLevelKind = "truecolor" | "ansi256" | "ansi16" | "none";

export interface ColorLevel {
  readonly kind: ColorLevelKind;
}

/** Resolve a `(key, text) => text` theme painter with the lazy-probe contract
 * shared by the header and the interaction-summary entry renderer: the host
 * may hand over an unbound theme proxy (early construction), so the painter
 * is chosen at use time — bound theme first (`fg("dim", …)` must return a
 * DIFFERENT string), then the host's globalThis theme symbol, else identity.
 * One implementation so the two surfaces cannot drift. */
export function resolveThemePainter(theme: unknown): (key: string, text: string) => string {
  const probe = (fg: (k: string, t: string) => string): boolean => {
    try {
      const probeText = "\u0000probe";
      return typeof fg("dim", probeText) === "string" && fg("dim", probeText) !== probeText;
    } catch {
      return false;
    }
  };
  const bound = theme as { fg?: (k: string, t: string) => string } | undefined;
  if (bound && typeof bound.fg === "function") {
    const fg = bound.fg;
    if (probe(fg)) return (k, t) => fg(k, t);
  }
  const globalTheme = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ] as { fg?: (k: string, t: string) => string } | undefined;
  if (globalTheme && typeof globalTheme.fg === "function") {
    const fg = globalTheme.fg;
    if (probe(fg)) return (k, t) => fg(k, t);
  }
  return (_k: string, t: string) => t;
}


/**
 * Pipeline-wide color context. One resolver, one source of truth: the live
 * host passes pi-tui's real `getCapabilities()`; env vars only degrade.
 *  - NO_COLOR / FORCE_COLOR=0        -> none (no SGR output at all)
 *  - FORCE_COLOR=1|2                 -> at most ansi256
 *  - FORCE_COLOR=3                   -> truecolor
 *  - otherwise pi-tui's trueColor detection, then TERM=…256color, then ansi16.
 */
export function resolveColorContext(options?: {
  env?: NodeJS.ProcessEnv;
  terminalTrueColor?: boolean;
}): ColorLevel {
  const env = options?.env ?? process.env;
  if (env.NO_COLOR) return { kind: "none" };
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return { kind: "none" };
  if (force === "1" || force === "2") {
    return options?.terminalTrueColor ? { kind: "truecolor" } : { kind: "ansi256" };
  }
  if (force === "3") return { kind: "truecolor" };
  if (options?.terminalTrueColor === true) return { kind: "truecolor" };
  const colorterm = env.COLORTERM ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return { kind: "truecolor" };
  // Windows Terminal promotes to truecolor (WT_SESSION / TERM_PROGRAM).
  if (env.WT_SESSION || env.TERM_PROGRAM === "WindowsTerminal") return { kind: "truecolor" };
  if (env.TERM && /256color/.test(env.TERM)) return { kind: "ansi256" };
  return { kind: "ansi16" };
}

/** Back-compat alias used by older call sites/tests. */
export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  return resolveColorContext({ env, terminalTrueColor: false });
}

function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  if (value.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) throw new Error(`Invalid hex color: ${hex}`);
  return { r, g, b };
}

/** SGR-256 quantization used by Codex's fallback path (cube + grayscale ramp). */
export function rgbToAnsi256({ r, g, b }: Rgb): number {
  const cube = [0, 95, 135, 175, 215, 255];
  const grays = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
  const nearest = (value: number, table: readonly number[]) => {
    let index = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < table.length; i++) {
      const distance = Math.abs(value - table[i]!);
      if (distance < best) { best = distance; index = i; }
    }
    return index;
  };
  const rIdx = nearest(r, cube);
  const gIdx = nearest(g, cube);
  const bIdx = nearest(b, cube);
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIndex = 232 + nearest(gray, grays);
  const dist = (a: number, b: number) => (a - b) * (a - b);
  const cubeDistance = 0.299 * dist(r, cube[rIdx]!) + 0.587 * dist(g, cube[gIdx]!) + 0.114 * dist(b, cube[bIdx]!);
  const grayDistance = 0.299 * dist(r, gray) + 0.587 * dist(g, gray) + 0.114 * dist(b, gray);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10 && grayDistance < cubeDistance) return grayIndex;
  return cubeIndex;
}

function ansi256FromHex(hex: string): number {
  return rgbToAnsi256(hexToRgb(hex));
}

function ansi16FromHex(hex: string): number {
  // Codex ANSI-16 degradation keeps only the green/red cue; palette hues map
  // to the nearest of the 8 base colors to avoid pastels.
  const { r, g, b } = hexToRgb(hex);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luminance > 200) return 7; // white
  if (g > r && g > b) return 2; // green
  if (r > g && r > b) return 1; // red
  if (b > r && b > g) return 4; // blue
  if (luminance < 80) return 0; // black
  return 7;
}

export function foregroundAnsi(hex: string, level: ColorLevel): string {
  if (level.kind === "truecolor") {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  if (level.kind === "ansi256") return `\x1b[38;5;${ansi256FromHex(hex)}m`;
  if (level.kind === "none") return "";
  return `\x1b[3${ansi16FromHex(hex)}m`;
}

export function backgroundAnsi(rgb: Rgb, level: ColorLevel): string {
  if (level.kind === "truecolor") return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  if (level.kind === "ansi256") {
    const index = rgb === DIFF_ADD_BG ? DIFF_ADD_BG_256 : rgb === DIFF_DEL_BG ? DIFF_DEL_BG_256 : rgbToAnsi256(rgb);
    return `\x1b[48;5;${index}m`;
  }
  // ANSI-16 cannot represent the diff surfaces (foreground-only cues instead);
  // "none" emits no SGR at all.
  return "";
}

export const FG_DEFAULT = "\x1b[39m";
export const BG_RESET = "\x1b[49m";
export const ALL_RESET = "\x1b[0m";
export const DIM_ON = "\x1b[2m";
export const INTENSITY_RESET = "\x1b[22m";

/** Safe subset of SGR sequences Codex preserves in shell output. */
const SAFE_SGR = /^\x1b\[[0-?]*[ -/]*[@-~]/;

function isSafeSgr(sequence: string): boolean {
  // Only color/intensity SGR (…m) with numeric parameters is kept; other CSI
  // finals (cursor moves, erase, mode sets) are dropped.
  return /^\x1b\[[0-9;]*m$/.test(sequence) && !sequence.includes(":");
}

/**
 * Strip every control sequence except simple SGR colors (Codex's
 * `ansi_escape_line` equivalent). OSC/DCS/private sequences and C0 controls
 * never survive.
 */
export function sanitizeShellLine(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\x1b") {
      const rest = text.slice(index);
      // Any CSI sequence: keep it only when it is a plain SGR color (…m).
      const csi = SAFE_SGR.exec(rest);
      if (csi && isSafeSgr(csi[0])) { out += csi[0]; index += csi[0].length; continue; }
      if (csi) { index += csi[0].length; continue; }
      const stringSeq = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(rest)
        ?? /^\x1b[P^_X][\s\S]*?\x1b\\/.exec(rest);
      if (stringSeq) { index += stringSeq[0].length; continue; }
      const twoByte = /^\x1b[@-_]/.exec(rest);
      if (twoByte) { index += twoByte[0].length; continue; }
      index += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    // Keep \n (line separator consumed by callers) and \t; strip other C0/C1.
    if (char !== "\n" && char !== "\t" && (code < 0x20 || (code >= 0x7f && code < 0xa0))) {
      index += 1;
      continue;
    }
    // Drop bidi/format controls that could spoof rendering.
    if (code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069) {
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
