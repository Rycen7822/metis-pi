import test from "node:test";
import assert from "node:assert/strict";
import { CustomEditor, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { makeCodexEditorFactory } from "../../src/chrome/editor.ts";
import { createHardwareCursor } from "../../src/chrome/hardware-cursor.ts";
import { CURSOR_MARKER, makeSurfaceOps } from "../../src/surface.ts";
import { theme } from "../helpers.mjs";
import { altScreen, container } from "../helpers/ui-fixtures.mjs";

initTheme("dark", false);
// Native status text reads the global app binding; no personal config/files.
Tui.setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } }));

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
  assert.equal(visibleWidth(surface.paintRow("\x1b[31mX\x1b[0m", 40)), 40, "colored rows fill the whole surface");
  const editor = nativeEditor({ surface, hardwareCursor: cursor.acquire, promptPrefix: true, placeholder: "Ask anything..." }, tui);
  const empty = editor.render(80);
  assert.ok(empty.every((row) => row.includes("\x1b[48;2;31;31;31m")));
  assert.match(Tui.stripTerminalSequences(empty[1]), /^> .*Ask anything\.\.\./);
  assert.doesNotMatch(empty.join("\n"), /──/);
  assert.equal(editor.getText(), "");
  assert.match(editor.renderTopBorder(80, 3), /↑ 3 more/);
  assert.match(editor.renderBottomBorder(80, 2), /↓ 2 more/);
  tui.setLayoutRoot(container(editor));
  tui.setFocus(editor);

  for (const [text, offset, glyph] of [["", 0, " "], ["abc", 1, "b"], ["你a", 0, "你"], ["👩‍👩‍👦a", 0, "👩‍👩‍👦"], ["éa", 0, "é"]]) {
    editor.setText(text);
    editor.setCursorCol(offset);
    const row = editor.render(80)[1];
    assert.ok(row.includes(`${CURSOR_MARKER}${Tui.renderFakeCursor(glyph)}`), "literal grapheme remains at its IME marker");
    tui.doRender();
    assert.doesNotMatch(tui.previousScreen.join("\n"), /\x1b\[7m/, "Pi resolves the focused fake cursor to the hardware cursor");
    assert.equal(visibleWidth(row), 80);
    assert.equal(editor.getText(), text);
  }
  editor.setText("hello world");
  editor.handleInput("\x1b[D");
  editor.handleInput("\x1b[D");
  assert.equal(editor.getCursor().col, 9);
  const row = editor.render(80)[1];
  assert.ok(row.includes(`wor${CURSOR_MARKER}${Tui.renderFakeCursor("l")}`));
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

  const bordered = nativeEditor({ hardwareCursor: cursor.acquire }, tui);
  bordered.setText("你a");
  bordered.setCursorCol(0);
  assert.match(bordered.render(45).join("\n"), /─{10}/);
  assert.ok(bordered.render(45)[1].includes(`${CURSOR_MARKER}${Tui.renderFakeCursor("你")}`));
  cursor.release();
  const fallback = nativeEditor({ surface }, tui);
  fallback.setText("world");
  fallback.setCursorCol(3);
  assert.ok(fallback.render(45)[1].includes(`${CURSOR_MARKER}${Tui.renderFakeCursor("l")}`));
  tui.setLayoutRoot(container(fallback));
  tui.setFocus(fallback);
  tui.doRender();
  assert.match(tui.previousScreen.join("\n"), /\x1b\[7ml\x1b\[27m/, "Pi draws the fake cursor when hardware visibility is off");
});

function compactionHost(t, surfaceEnabled = true) {
  const { tui } = altScreen();
  const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } });
  const defaultEditor = new CustomEditor(tui, { ...theme, borderColor: text => text }, keybindings);
  let cancelled = 0;
  let idleEscapes = 0;
  defaultEditor.onEscape = () => { idleEscapes++; };
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    isInitialized: true, ui: tui, keybindings, defaultEditor, editor: defaultEditor,
    editorContainer: new Tui.Container(), statusContainer: new Tui.Container(),
    chatContainer: new Tui.Container(), compactionQueuedMessages: [], outputPad: 1,
    options: { tuiMode: "fullscreen" }, footer: { invalidate() {} },
    programStatus: { handleEvent() {} }, // Pi1.1 terminal-program status, unrelated to editor rendering
    runtimeHost: { session: {
      settingsManager: { getShowTerminalProgress: () => false },
      abortCompaction() { cancelled++; },
    } },
  });
  const surface = surfaceEnabled ? makeSurfaceOps({ kind: "truecolor" }, text => text, text => text) : undefined;
  host.setCustomEditorComponent(makeCodexEditorFactory({ host: { CustomEditor }, surface, embedWorkingStatus: true }));
  const editor = host.editor;
  editor.focused = true;
  t.after(() => host.clearStatusIndicator());
  return { host, editor, counts: () => ({ cancelled, idleEscapes }) };
}

test("native manual/auto compaction shares the editor row with elapsed time, without patches or timers", async t => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  const originals = [CustomEditor.prototype, InteractiveMode.prototype, Tui.Loader.prototype]
    .map(prototype => [prototype, Object.getOwnPropertyDescriptors(prototype)]);
  for (const surface of [true, false]) {
    const { host, editor, counts } = compactionHost(t, surface);
    editor.setText("你好 draft");
    for (const reason of ["manual", "threshold", "overflow"]) {
      const widths = [10, 16, 27, 40, 100];
      const bodyRows = new Map(widths.map(width => [width, editor.render(width).slice(1)]));
      const before = intervals.mock.callCount();
      await host.handleEvent({ type: "compaction_start", reason });
      assert.equal(host.activeWorkingIndicatorEmbedded, true, "native host delivers its status via the public editor API");
      assert.equal(host.statusContainer.children.length, 0, "no duplicate native loader row");
      const row = width => Tui.stripTerminalSequences(editor.render(width)[0]);
      assert.match(row(100), reason === "manual" ? /Compacting context/ : /Auto-compacting/);
      if (reason === "overflow") assert.match(row(100), /Context overflow detected/);
      assert.match(row(100), /escape.*cancel.* · 0s/);
      assert.match(Tui.stripTerminalSequences(editor.renderTopBorder(120, 3)), / · 0s · ↑ 3 more/, "scroll information remains visible when it fits");
      if (reason === "manual") {
        const nativeWidth = visibleWidth(host.activeStatusIndicator.renderInBorder(100));
        assert.match(row(nativeWidth + 2), /escape.*cancel/);
        assert.doesNotMatch(row(nativeWidth + 2), / · 0s/, "elapsed never clips an otherwise fitting cancel hint");
      }
      now += 65_000;
      assert.match(row(100), / · 1m 05s/);
      now += 3_600_000;
      assert.match(row(100), / · 1h 01m 05s/);
      for (const width of widths) {
        const rows = editor.render(width);
        assert.ok(rows.every(line => visibleWidth(line) <= width), `native status fits ${width} columns`);
        assert.deepEqual(rows.slice(1), bodyRows.get(width), "body, wrapped cursor and autocomplete geometry stay unchanged");
      }
      assert.equal(editor.getText(), "你好 draft", "display timing never edits the draft");
      assert.equal(intervals.mock.callCount() - before, 1, "only the native spinner schedules an interval");
      editor.handleInput("\x1b");
      assert.equal(counts().cancelled, ["manual", "threshold", "overflow"].indexOf(reason) + 1, "Escape still reaches native abortCompaction");
      await host.handleEvent({ type: "compaction_end", reason, aborted: true });
      assert.doesNotMatch(row(100), /compacting|Compacting|1h 01m 05s/);
      editor.handleInput("\x1b");
      assert.equal(counts().idleEscapes, ["manual", "threshold", "overflow"].indexOf(reason) + 1, "native Escape handler is restored after cancellation");
    }
  }
  for (const [prototype, descriptors] of originals) assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), descriptors);
});

test("compaction elapsed survives native retry swaps and resets after failure or editor replacement", async t => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { host, editor } = compactionHost(t);
  const row = () => Tui.stripTerminalSequences(host.editor.render(100)[0]);
  await host.handleEvent({ type: "compaction_start", reason: "manual" });
  now += 5_000;
  await host.handleEvent({ type: "summarization_retry_scheduled", source: "compaction", reason: "manual", attempt: 1, maxAttempts: 2, delayMs: 10_000, errorMessage: "Temporary offline failure" });
  assert.match(row(), /Retrying/);
  assert.doesNotMatch(row(), / · 5s/, "only compaction receives an elapsed suffix");
  now += 10_000;
  await host.handleEvent({ type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" });
  assert.match(row(), /Compacting.* · 15s/, "retry/backoff time belongs to the same compaction operation");
  await host.handleEvent({ type: "compaction_end", reason: "manual", errorMessage: "Expected offline failure", aborted: false });
  assert.doesNotMatch(row(), /Compacting| · 15s/);
  now += 50_000;
  await host.handleEvent({ type: "compaction_start", reason: "threshold" });
  assert.match(row(), /Auto-compacting.* · 0s/, "new compaction does not inherit the prior duration");
  host.clearStatusIndicator("compaction");
  await Promise.resolve();
  host.setCustomEditorComponent(makeCodexEditorFactory({ host: { CustomEditor }, embedWorkingStatus: true }));
  assert.notEqual(host.editor, editor);
  now += 50_000;
  await host.handleEvent({ type: "compaction_start", reason: "overflow" });
  assert.match(row(), /Auto-compacting.* · 0s/, "a fresh editor owns a fresh clock");
  await host.handleEvent({ type: "summarization_retry_scheduled", source: "branchSummary", attempt: 1, maxAttempts: 2, delayMs: 1_000, errorMessage: "Offline branch retry" });
  await host.handleEvent({ type: "summarization_retry_attempt_start", source: "branchSummary" });
  assert.match(row(), /Summarizing branch/);
  assert.doesNotMatch(row(), / · \d+s/, "other native status kinds remain visible without compaction timing");
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
