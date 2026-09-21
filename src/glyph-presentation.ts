// Text-presentation normalization for transcript glyphs. Display-only, and the
// last mile only: the frame string a TUI hands to its terminal is scanned and
// marks that a terminal may draw from its color-emoji font get an explicit
// text-presentation selector (U+FE0E) appended, so the monospace font draws
// them instead — one cell wide, monochrome, and, the actual defect, no longer
// painting ~1.6 cells of emoji ink on top of the character in the next cell.
//
// 0.14.0 background: U+2714/U+2716 (✔ ✖) are what node's test reporter, git
// hooks and plenty of other tools print. Terminals advance ONE cell for them
// (pi-tui's width table agrees: they are 1-wide unless a VS16 widens the
// cluster), but an emoji font draws the glyph about two cells wide and the
// terminal composites color glyphs over the text layer, so a command recorded
// as `grep -n "✖\|# fail\|peek:"` reaches the screen as `✖|# fail` — the
// backslash is under the ✖ — and `✖ peek:` reads as `✖peek:`. Nothing is lost
// from the content: the session log, the copy serializers and the TUI's own
// screen model keep the original text. Only the bytes handed to the terminal
// gain a default-ignorable selector, which pi-tui's width table already counts
// as zero ([65024,65039,0]) and no layout math runs over afterwards.
//
// Constraints that shape the code:
//   * only terminal writes are rewritten (never component renders), so
//     selection-copy stays byte-exact and the TUI's diffing/screen buffers are
//     untouched;
//   * escape sequences are copied verbatim — an OSC 8 hyperlink's URL or an OSC
//     52 clipboard payload must never grow a selector inside it;
//   * an explicit U+FE0F (emoji request) is respected: if the content asked for
//     the emoji form, we do not fight it;
//   * the fast path is a single regex probe, so a frame with none of these
//     glyphs costs one scan and is passed through by identity.

const OWNER = Symbol.for("Rycen7822.metis-pi.glyph-presentation.v1");

/**
 * Marks a terminal may render from an emoji font, which monospace fonts
 * (DejaVu, Cascadia, JetBrains Mono, every Nerd Font) also carry in text form:
 * ✔ ✖ (node/git/CI output), ✓ ✗ (linters) and ⚠ (warnings).
 */
export const DEFAULT_TEXT_PRESENTATION_GLYPHS: readonly string[] = ["\u2714", "\u2716", "\u2713", "\u2717", "\u26a0"];

const VS15 = "\ufe0e";
const VS16 = "\ufe0f";
const ESC = 0x1b;
const BEL = 0x07;

/**
 * End index (exclusive) of the escape sequence starting at `start` (an ESC).
 * CSI/OSC/SS3 sequences are skipped whole; a truncated sequence runs to the end
 * of the frame, which is the safe answer for a partially written row.
 */
export function escapeSequenceEnd(text: string, start: number): number {
  const next = text.charCodeAt(start + 1);
  if (next === 0x5b) {
    // CSI: parameters (0x30-0x3f), intermediates (0x20-0x2f), one final byte
    // (0x40-0x7e). Frames are full of these — getting it wrong would swallow the
    // rest of the frame and silently disable the whole feature.
    for (let at = start + 2; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code >= 0x40 && code <= 0x7e) return at + 1;
    }
    return text.length;
  }
  if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    // OSC (]) and the string sequences DCS (P), SOS (X), PM (^), APC (_): run to
    // BEL (OSC's shortcut) or ST (ESC \\).
    for (let at = start + 2; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code === BEL) return at + 1;
      if (code === ESC) return text.charCodeAt(at + 1) === 0x5c ? at + 2 : at + 1;
    }
    return text.length;
  }
  if (Number.isNaN(next)) return text.length;
  // Two-character escapes (ESC c, ESC 7, ESC =, …) and anything unusual.
  return start + 2;
}

export interface GlyphPresenter {
  /** Single code points that receive the selector, in order. */
  readonly glyphs: readonly string[];
  /** Appends U+FE0E after each listed mark that has no explicit selector. */
  present(text: string): string;
}

function escapeForCharacterClass(value: string): string {
  return value.replace(/[\\\]^[-]/g, "\\$&");
}

export function createGlyphPresenter(include: readonly string[] = []): GlyphPresenter {
  const codes = new Set<number>();
  const glyphs: string[] = [];
  for (const value of [...DEFAULT_TEXT_PRESENTATION_GLYPHS, ...include]) {
    const cp = value.codePointAt(0);
    if (cp === undefined || cp < 0x80) continue; // ASCII never needs a selector
    const size = cp > 0xffff ? 2 : 1;
    if (value.length !== size) continue; // exactly one code point per entry
    if (codes.has(cp)) continue;
    codes.add(cp);
    glyphs.push(value);
  }
  const guard = glyphs.length > 0 ? new RegExp(`[${glyphs.map(escapeForCharacterClass).join("")}]`) : undefined;

  return {
    glyphs,
    present(text: string): string {
      if (!guard || !guard.test(text)) return text;
      let out = "";
      let at = 0;
      while (at < text.length) {
        const code = text.charCodeAt(at);
        if (code === ESC) {
          const end = escapeSequenceEnd(text, at);
          out += text.slice(at, end);
          at = end;
          continue;
        }
        if (code < 0x80) {
          out += text[at];
          at += 1;
          continue;
        }
        const cp = text.codePointAt(at) as number;
        const size = cp > 0xffff ? 2 : 1;
        out += text.slice(at, at + size);
        at += size;
        if (!codes.has(cp)) continue;
        const after = text[at];
        if (after === VS15 || after === VS16) continue; // explicit presentation wins
        out += VS15;
      }
      return out;
    },
  };
}

export interface GlyphPresentationStatus {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly glyphs: readonly string[];
  /** Frame writes observed since install. */
  readonly frames: number;
  /** Frame writes that actually changed. */
  readonly changed: number;
  readonly reason: string;
}

export interface GlyphPresentationSystem {
  /** Wrap the TUI's terminal writer (or the TUI itself when it owns `write`). */
  installOnTui(tui: unknown): boolean;
  /** Rewrite one frame string (also used by tests and diagnostics). */
  present(text: string): string;
  status(): GlyphPresentationStatus;
}

type Writable = Record<string, unknown> & { write?: unknown };

/**
 * Patches `write` on the writer object (the terminal's prototype, or an own
 * instance method when one shadows the class method). Idempotent per object via
 * an owner symbol, so repeated installs from captureTui/agent activity neither
 * stack wrappers nor double-count frames.
 */
function wrapWriter(target: Writable, present: (text: string) => string, count: (changed: boolean) => void): boolean {
  const current = target.write;
  if (typeof current !== "function") return false;
  const marked = current as unknown as Record<symbol, unknown>;
  if (marked[OWNER] === true) return true;
  const writer = current as (data: unknown) => unknown;
  const wrapper = function (this: unknown, data: unknown): unknown {
    if (typeof data !== "string") return writer.call(this, data);
    const next = present(data);
    count(next !== data);
    return writer.call(this, next);
  };
  Object.defineProperty(wrapper, OWNER, { value: true });
  target.write = wrapper;
  return true;
}

export function createGlyphPresentation(options: { enabled: boolean; include?: readonly string[] }): GlyphPresentationSystem {
  const presenter = createGlyphPresenter(options.include ?? []);
  let installed = false;
  let frames = 0;
  let changed = 0;
  let reason = options.enabled ? "not installed" : "disabled";

  const count = (didChange: boolean): void => {
    frames += 1;
    if (didChange) changed += 1;
  };

  return {
    installOnTui(tui: unknown): boolean {
      if (!options.enabled) {
        reason = "disabled";
        return false;
      }
      if (!tui || typeof tui !== "object") {
        reason = "invalid tui";
        return false;
      }
      const terminal = (tui as { terminal?: unknown }).terminal;
      const candidate = (terminal && typeof terminal === "object" ? terminal : tui) as Writable;
      const own = Object.prototype.hasOwnProperty.call(candidate, "write");
      const target = own ? candidate : (Object.getPrototypeOf(candidate) as Writable | null);
      if (!target || !wrapWriter(target, (text) => presenter.present(text), count)) {
        reason = "no terminal writer";
        return false;
      }
      installed = true;
      reason = own ? "instance write" : "terminal prototype write";
      return true;
    },
    present: (text: string) => presenter.present(text),
    status: () => ({ enabled: options.enabled, installed, glyphs: presenter.glyphs, frames, changed, reason }),
  };
}
