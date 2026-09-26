// Native editor contracts own surface, IME and completion.
import test from "node:test";
import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { makeCodexEditorFactory } from "../../src/chrome/editor.ts";
import { createHardwareCursor } from "../../src/chrome/hardware-cursor.ts";
import { CURSOR_MARKER, makeSurfaceOps } from "../../src/surface.ts";
import { theme } from "../helpers.mjs";
import { altScreen, container } from "../helpers/ui-fixtures.mjs";

function nativeEditor(options = {}, tui = altScreen().tui, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
  const editor = makeCodexEditorFactory({ host: { CustomEditor }, ...options })(
    tui, { ...theme, borderColor: (text) => text }, keybindings,
  );
  editor.focused = true;
  return editor;
}

test("real editor surface, IME glyphs and hardware cursor survive one terminal lifecycle", (t) => {
  const { tui, terminal } = altScreen(80);
  terminal.hideCursor = () => terminal.write("\x1b[?25l");
  terminal.showCursor = () => terminal.write("\x1b[?25h");
  const cursor = createHardwareCursor();
  t.after(() => cursor.release());
  const surface = makeSurfaceOps({ kind: "truecolor" }, (text) => `\x1b[36m${text}\x1b[39m`, (text) => text);
  const editor = nativeEditor({ surface, hardwareCursor: cursor.acquire, promptPrefix: true, placeholder: "Ask anything..." }, tui);
  const empty = editor.render(80);
  assert.ok(empty.every((row) => row.includes("\x1b[48;2;31;31;31m")));
  assert.match(Tui.stripTerminalSequences(empty[1]), /^> .*Ask anything\.\.\./);
  assert.doesNotMatch(empty.join("\n"), /──/);
  assert.equal(editor.getText(), "");
  assert.match(editor.renderTopBorder(80, 3), /↑ 3 more/);
  assert.match(editor.renderBottomBorder(80, 2), /↓ 2 more/);

  for (const [text, offset, glyph] of [["", 0, " "], ["abc", 1, "b"], ["你a", 0, "你"], ["👩‍👩‍👦a", 0, "👩‍👩‍👦"], ["éa", 0, "é"]]) {
    editor.setText(text);
    editor.setCursorCol(offset);
    const row = editor.render(80)[1];
    assert.ok(row.includes(`${CURSOR_MARKER}${glyph}\x1b[0m`), "literal grapheme remains at its IME marker");
    assert.doesNotMatch(row, /\x1b\[7m/);
    assert.equal(visibleWidth(row), 80);
    assert.equal(editor.getText(), text);
  }
  editor.setText("hello world");
  editor.handleInput("\x1b[D");
  editor.handleInput("\x1b[D");
  assert.equal(editor.getCursor().col, 9);
  const row = editor.render(80)[1];
  assert.ok(row.includes(`wor${CURSOR_MARKER}l\x1b[0m`));
  assert.match(Tui.stripTerminalSequences(row), /hello world/);
  assert.doesNotMatch(row, /Ask anything/);
  tui.setLayoutRoot(container(editor));
  tui.setFocus(editor);
  tui.doRender();
  assert.match(terminal.writes.join(""), /\x1b\[6 q[\s\S]*\x1b\[\?25h/);
  editor.focused = false;
  assert.doesNotMatch(editor.render(80)[1], /▏/);
  cursor.release();
  assert.equal(tui.getShowHardwareCursor(), false);
  assert.equal(terminal.writes.at(-1), "\x1b[0 q");

  const legacy = nativeEditor({ hardwareCursor: () => () => true });
  legacy.setText("你a");
  legacy.setCursorCol(0);
  assert.match(legacy.render(45).join("\n"), /─{10}/);
  assert.ok(legacy.render(45)[1].includes(`${CURSOR_MARKER}你\x1b[0m`));
  const fallback = nativeEditor({ surface });
  fallback.setText("world");
  fallback.setCursorCol(3);
  assert.ok(fallback.render(45)[1].includes(`${CURSOR_MARKER}\x1b[7ml\x1b[0m`));
});

test("editor factory: the composer forces the completion query for a second skill trigger", () => {
  const calls = { triggers: 0 };
  // Count only the extension's forced query, not the native input handler's
  // own autocomplete attempts. Editing/cursor movement remain real host code.
  class CompletionProbe extends CustomEditor {
    showing = false;
    handleInput(data) {
      this.nativeInput = true;
      try { super.handleInput(data); }
      finally { this.nativeInput = false; }
    }
    tryTriggerAutocomplete() { if (!this.nativeInput) calls.triggers += 1; }
    isShowingAutocomplete() { return this.showing; }
  }
  const host = { CustomEditor: CompletionProbe };
  const editor = nativeEditor({ host, skillTrigger: true });

  // Each gesture declares its own expected query count; no cumulative oracle.
  for (const [text, key, showing, queries] of [
    ["", "/", false, 0],
    ["/skill:alpha ", "/", false, 1],
    ["/skill:alpha ", "/", true, 0],
    ["/skill:alpha ", "x", false, 0],
  ]) {
    calls.triggers = 0;
    editor.setText(text);
    editor.showing = showing;
    editor.handleInput(key);
    assert.equal(calls.triggers, queries, `${JSON.stringify(text)} + ${key}, menu=${showing}`);
  }
  const plain = nativeEditor({ host });
  plain.setText("/skill:alpha ");
  plain.handleInput("/");
  assert.equal(calls.triggers, 0, "hook is opt-in");
});
