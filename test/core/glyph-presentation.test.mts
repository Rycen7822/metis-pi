import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGlyphPresenter, createGlyphPresentation } from "../../src/appearance/chrome/glyph-presentation.ts";

const mark = "✖";
const textSelector = "\ufe0e";
const textMark = `${mark}${textSelector}`;

test("glyph presentation changes content marks only, preserving exact bytes and terminal width", () => {
  const presenter = createGlyphPresenter();
  for (const [source, expected] of [
    ["plain 汉字 └─ │ 🎉\u0000\u0007", "plain 汉字 └─ │ 🎉\u0000\u0007"],
    ["✔ ✖ ✓ ✗ ⚠", "✔\ufe0e ✖\ufe0e ✓\ufe0e ✗\ufe0e ⚠\ufe0e"],
    [`grep -n "${mark}\\|peek:"`, `grep -n "${textMark}\\|peek:"`],
    [`🎉${mark}${mark}🎉`, `🎉${textMark}${textMark}🎉`],
    [`${textMark} ${mark}\ufe0f`, `${textMark} ${mark}\ufe0f`],
    [`\x1b[33m${mark}\x1b[0m`, `\x1b[33m${textMark}\x1b[0m`],
    [`\x1b]8;;https://x/${mark}\x07${mark}\x1b]8;;\x07`, `\x1b]8;;https://x/${mark}\x07${textMark}\x1b]8;;\x07`],
    [`\x1b]8;;https://x/${mark}\x1b\\${mark}`, `\x1b]8;;https://x/${mark}\x1b\\${textMark}`],
    [`\x1b]52;c;YWJj${mark}\x07`, `\x1b]52;c;YWJj${mark}\x07`],
    [`\x1bP${mark}\x1b\\${mark}`, `\x1bP${mark}\x1b\\${textMark}`],
    [`row ${mark}\x1b[3`, `row ${textMark}\x1b[3`],
    [`\x1b7${mark}`, `\x1b7${textMark}`],
    ["", ""],
  ]) {
    const actual = presenter.present(source);
    assert.equal(actual, expected, JSON.stringify(source));
    assert.equal(visibleWidth(actual), visibleWidth(source), "selectors cannot shift later terminal cells");
  }
});

test("one terminal prototype installation transforms text frames and preserves binary writes", t => {
  const written: unknown[] = [];
  class Terminal {
    write(data: unknown) { written.push(data); }
  }
  const terminal = new Terminal();
  const system = createGlyphPresentation({ enabled: true });
  t.after(() => system.dispose?.());
  assert.equal(system.installOnTui({ terminal }), true);
  assert.equal(system.installOnTui({ terminal }), true);
  terminal.write(`frame ${mark} peek\n`);
  terminal.write("plain\n");
  terminal.write(Buffer.from("binary\0frame"));
  new Terminal().write("✔!");
  assert.deepEqual(written, [`frame ${textMark} peek\n`, "plain\n", Buffer.from("binary\0frame"), "✔\ufe0e!"]);
});

test("release restores native writes and a later activation uses its own glyph preferences", t => {
  const written: unknown[] = [];
  class Terminal { write(data: unknown) { written.push(data); } }
  const terminal = new Terminal();
  const original = Object.getOwnPropertyDescriptor(Terminal.prototype, "write");
  const first = createGlyphPresentation({ enabled: true, include: ["◆"] });
  const next = createGlyphPresentation({ enabled: true, include: ["★"] });
  t.after(() => { first.dispose?.(); next.dispose?.(); });
  first.installOnTui({ terminal });
  terminal.write("◆★");
  first.dispose(); first.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(Terminal.prototype, "write"), original);
  terminal.write("◆★");
  next.installOnTui({ terminal });
  terminal.write("◆★");
  assert.deepEqual(written, ["◆\ufe0e★", "◆★", "◆★\ufe0e"]);
  assert.equal(next.status().frames, 1);
  assert.equal(first.status().installed, false);
});

test("writer leases coexist and releasing the latest restores the previous presenter", t => {
  const written: unknown[] = [];
  class Terminal { write(data: unknown) { written.push(data); } }
  const terminal = new Terminal();
  const first = createGlyphPresentation({ enabled: true, include: ["◆"] });
  const second = createGlyphPresentation({ enabled: true, include: ["★"] });
  t.after(() => { first.dispose?.(); second.dispose?.(); });
  first.installOnTui({ terminal });
  second.installOnTui({ terminal });
  first.installOnTui({ terminal });
  terminal.write("◆★");
  second.dispose();
  terminal.write("◆★");
  first.dispose();
  terminal.write("◆★");
  assert.deepEqual(written, ["◆★\ufe0e", "◆\ufe0e★", "◆★"]);
});

test("inherited terminal writers retain their prototype shape after all leases close", t => {
  for (const baseFirst of [false, true]) {
    const written: unknown[] = [];
    class Terminal { write(data: unknown) { written.push(data); } }
    class Derived extends Terminal {}
    const native = Object.getOwnPropertyDescriptor(Terminal.prototype, "write");
    const parent = createGlyphPresentation({ enabled: true, include: ["★"] });
    const child = createGlyphPresentation({ enabled: true, include: ["◆"] });
    t.after(() => { parent.dispose(); child.dispose(); });
    if (baseFirst) parent.installOnTui({ terminal: new Terminal() });
    assert.equal(child.installOnTui({ terminal: new Derived() }), true);
    new Derived().write("◆★");
    assert.deepEqual(written, ["◆\ufe0e★"]);
    parent.dispose(); child.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(Terminal.prototype, "write"), native);
    assert.equal(Object.hasOwn(Derived.prototype, "write"), false);
    new Derived().write("◆★");
    assert.equal(written.at(-1), "◆★");
  }
});

test("release leaves a later writer alone and retained wrappers become inert", () => {
  const written: unknown[] = [];
  class Terminal { write(data: unknown) { written.push(data); } }
  const terminal = new Terminal();
  const system = createGlyphPresentation({ enabled: true });
  system.installOnTui({ terminal });
  const retained = terminal.write;
  const later = (data: unknown) => written.push(data);
  Terminal.prototype.write = later;
  system.dispose();
  assert.equal(terminal.write, later);
  retained.call(terminal, mark);
  assert.deepEqual(written, [mark]);
});
