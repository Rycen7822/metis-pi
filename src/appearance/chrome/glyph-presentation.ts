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
  /** Release only this activation's writers, preserving later owners. */
  dispose(): void;
}

type Writable = Record<string, unknown> & { write?: unknown };

interface WriterLease {
  present(text: string): string;
  count(changed: boolean): void;
}
interface WriterHook {
  target: Writable;
  original: PropertyDescriptor | undefined;
  wrapped: (this: unknown, data: unknown) => unknown;
  leases: Set<WriterLease>;
  active: WriterLease | undefined;
}

/** Share one wrapper across activations; the latest live lease owns presentation.
 * No per-frame collection copies, and a retained wrapper becomes inert on release. */
function leaseWriter(target: Writable, lease: WriterLease): (() => void) | string {
  const descriptor = Object.getOwnPropertyDescriptor(target, "write");
  const current = target.write as WriterHook["wrapped"];
  if (typeof current !== "function") return "no terminal writer";
  const marked = (current as unknown as Record<symbol, unknown>)[OWNER];
  // Old releases did not retain their original writer, so they cannot safely
  // be unwrapped during a hot upgrade. Never claim that new options took over.
  if (marked === true) return "legacy writer requires Pi restart";
  let hook = marked as WriterHook | undefined;
  if (!hook) {
    if (descriptor ? !("value" in descriptor) || !descriptor.writable : !Object.isExtensible(target))
      return "no writable terminal writer";
    const owned: WriterHook = {
      target, original: descriptor, leases: new Set(), active: undefined,
      wrapped(data) {
        const active = owned.active;
        if (!active || typeof data !== "string") return current.call(this, data);
        const next = active.present(data);
        active.count(next !== data);
        return current.call(this, next);
      },
    };
    Object.defineProperty(owned.wrapped, OWNER, { value: owned });
    if (!Reflect.defineProperty(target, "write", descriptor
      ? { ...descriptor, value: owned.wrapped }
      : { value: owned.wrapped, writable: true, configurable: true, enumerable: true })) return "terminal writer unavailable";
    hook = owned;
  }
  const owned = hook;
  owned.leases.add(lease);
  owned.active = lease;
  return () => {
    if (!owned.leases.delete(lease)) return;
    if (owned.active === lease) {
      owned.active = undefined;
      for (const remaining of owned.leases) owned.active = remaining;
    }
    const live = Object.getOwnPropertyDescriptor(owned.target, "write");
    if (!owned.leases.size && live?.value === owned.wrapped
      && live.writable === (owned.original?.writable ?? true)
      && live.configurable === (owned.original?.configurable ?? true)
      && live.enumerable === (owned.original?.enumerable ?? true)) {
      if (owned.original) Reflect.defineProperty(owned.target, "write", owned.original);
      else Reflect.deleteProperty(owned.target, "write");
    }
  };
}

export function createGlyphPresentation(options: { enabled: boolean; include?: readonly string[] }): GlyphPresentationSystem {
  const presenter = createGlyphPresenter(options.include ?? []);
  const releases = new Map<Writable, () => void>();
  let frames = 0;
  let changed = 0;
  let reason = options.enabled ? "not installed" : "disabled";

  const count = (didChange: boolean): void => {
    frames += 1;
    if (didChange) changed += 1;
  };

  const lease = { present: presenter.present, count };
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
      if (!target) { reason = "no terminal writer"; return false; }
      if (releases.has(target)) return true;
      const release = leaseWriter(target, lease);
      if (typeof release === "string") { reason = release; return false; }
      releases.set(target, release);
      reason = own ? "instance write" : "terminal prototype write";
      return true;
    },
    present: presenter.present,
    status: () => ({ enabled: options.enabled, installed: releases.size > 0, glyphs: presenter.glyphs, frames, changed, reason }),
    dispose() {
      for (const release of releases.values()) release();
      releases.clear();
      reason = options.enabled ? "not installed" : "disabled";
    },
  };
}
