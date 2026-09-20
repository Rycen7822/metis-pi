// glyph-presentation.test.mts — the display-only text-presentation normalizer.
//
// 0.14.0 context: U+2714/U+2716 (✔ ✖) are printed by node's test reporter, git
// hooks and CI stamps alike. A terminal advances ONE cell for them and pi-tui's
// width table agrees, but an emoji font draws them about two cells wide and the
// terminal composites color glyphs over the text layer — so `grep -n "✖\|…"`
// reads as `✖|…` on screen (the backslash is under the ✖) and `✖ peek:` reads as
// `✖peek:`. Appending U+FE0E makes the monospace font draw them.
//
// These cases pin the four promises that make it safe: content glyphs only,
// escape sequences verbatim, explicit presentation respected, and nothing that
// changes layout (the selector is default-ignorable and zero-width).
import test from "node:test";
import assert from "node:assert/strict";
import {
  createGlyphPresenter,
  createGlyphPresentation,
  DEFAULT_TEXT_PRESENTATION_GLYPHS,
  escapeSequenceEnd,
} from "../../src/glyph-presentation.ts";

const CHECK = "\u2714";
const CROSS = "\u2716";
const VS15 = "\ufe0e";
const VS16 = "\ufe0f";

test("escapeSequenceEnd skips CSI, OSC (BEL and ST), and short escapes", () => {
  const csi = `x\u001b[38;5;203my`;
  assert.equal(escapeSequenceEnd(csi, 1), csi.indexOf("m") + 1, "CSI runs to its final byte");
  const osc = `\u001b]8;;https://x\u0007tail`;
  assert.equal(escapeSequenceEnd(osc, 0), osc.indexOf("\u0007") + 1, "OSC ends at BEL");
  const st = `\u001b]8;;https://x\u001b\\tail`;
  assert.equal(escapeSequenceEnd(st, 0), st.indexOf("\u001b\\") + 2, "OSC ends at ST");
  assert.equal(escapeSequenceEnd("\u001b7rest", 0), 2, "two-character escape");
  const truncated = "abc\u001b[38;5;203";
  assert.equal(escapeSequenceEnd(truncated, 3), truncated.length, "a truncated CSI runs to the end");
  assert.equal(escapeSequenceEnd("abc\u001b", 3), 4, "a lone ESC is not a crash");
  // String sequences that are not OSC also stop at ST rather than BEL.
  const dcs = `\u001bPq\u001b\\next`;
  assert.equal(escapeSequenceEnd(dcs, 0), dcs.indexOf("\u001b\\") + 2);
});

test("presenter: the curated marks get the selector, everything else is untouched", () => {
  const presenter = createGlyphPresenter();
  assert.deepEqual([...presenter.glyphs], [...DEFAULT_TEXT_PRESENTATION_GLYPHS]);
  assert.equal(presenter.present(`plain ascii`), "plain ascii");
  assert.equal(presenter.present(`${CHECK} ok`), `${CHECK}${VS15} ok`);
  assert.equal(presenter.present(`${CROSS} fail`), `${CROSS}${VS15} fail`);
  assert.equal(presenter.present(`\u2713 \u2717 \u26a0`), `\u2713${VS15} \u2717${VS15} \u26a0${VS15}`);
  // The reported defect: the character AFTER the mark keeps its own cell and is
  // no longer covered — the row only gains a zero-width selector.
  assert.equal(presenter.present(`grep -n "${CROSS}\\|# fail|peek:"`), `grep -n "${CROSS}${VS15}\\|# fail|peek:"`);
  assert.equal(presenter.present(`${CROSS} peek: done`), `${CROSS}${VS15} peek: done`);
  // Non-marks stay byte-identical: emoji, CJK, box drawing, astral pairs.
  const untouched = "🎉 汉字 └─ │ ⏺ · ✓\uFE0F ✔\uFE0F";
  assert.equal(presenter.present(untouched), untouched, "marks with an explicit presentation are respected");
  for (const text of ["", "no marks here", "🎉🎉", "\u0000\u0007", "a\u0000b"]) {
    assert.equal(presenter.present(text), text);
  }
});

test("presenter: an explicit presentation wins, ours is never doubled", () => {
  const presenter = createGlyphPresenter();
  assert.equal(presenter.present(`${CHECK}${VS15}`), `${CHECK}${VS15}`, "already text: no second selector");
  assert.equal(presenter.present(`${CHECK}${VS16}`), `${CHECK}${VS16}`, "content asked for emoji: leave it");
  assert.equal(presenter.present(`${CHECK}${VS16}x`), `${CHECK}${VS16}x`);
  assert.equal(presenter.present(`${CHECK}${CHECK}`), `${CHECK}${VS15}${CHECK}${VS15}`, "every occurrence");
  assert.equal(presenter.present(`🎉${CHECK}🎉`), `🎉${CHECK}${VS15}🎉`, "astral neighbours keep their boundary");
});

test("presenter: escape sequences are verbatim, including hyperlink URLs", () => {
  const presenter = createGlyphPresenter();
  // SGR around a mark: the styling bytes are untouched, the mark gains a selector.
  assert.equal(presenter.present(`\u001b[33m${CHECK}\u001b[0m`), `\u001b[33m${CHECK}${VS15}\u001b[0m`);
  // OSC 8: a URL that itself contains a mark must not be rewritten.
  const hyperlink = `\u001b]8;;https://example.com/${CHECK}\u0007${CHECK}\u001b]8;;\u0007`;
  assert.equal(
    presenter.present(hyperlink),
    `\u001b]8;;https://example.com/${CHECK}\u0007${CHECK}${VS15}\u001b]8;;\u0007`,
    "the label is normalized, the URL is not",
  );
  // An OSC 52 clipboard payload (base64) and a truncated frame end safely.
  const clipboard = `\u001b]52;c;YWJj${CHECK}\u0007`;
  assert.equal(presenter.present(clipboard), clipboard);
  assert.equal(presenter.present(`row ${CROSS}\u001b[3`), `row ${CROSS}${VS15}\u001b[3`);
});

test("system: installs on the terminal prototype once and rewrites frames", () => {
  const written: unknown[] = [];
  class FakeTerminal {
    write(data: unknown): void {
      written.push(data);
    }
  }
  const terminal = new FakeTerminal();
  const tui = { terminal };
  const system = createGlyphPresentation({ enabled: true });

  assert.equal(system.installOnTui(tui), true);
  assert.equal(system.installOnTui(tui), true, "idempotent");
  const status = system.status();
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.reason, "terminal prototype write");
  assert.equal(status.glyphs.length, DEFAULT_TEXT_PRESENTATION_GLYPHS.length);

  terminal.write(`frame ${CROSS} peek\n`);
  terminal.write("frame without marks\n");
  terminal.write(Buffer.from("binary\0frame"));
  assert.deepEqual(written, [`frame ${CROSS}${VS15} peek\n`, "frame without marks\n", Buffer.from("binary\0frame")]);
  assert.deepEqual(system.status().frames, 2, "only string frames are counted");
  assert.equal(system.status().changed, 1);
  // A SECOND terminal of the same class shares the patched prototype.
  const other = new FakeTerminal();
  other.write(`${CHECK}!`);
  assert.deepEqual(written.at(-1), `${CHECK}${VS15}!`);
});

