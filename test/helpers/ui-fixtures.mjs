// Real TUI components on an in-memory terminal. Never start a terminal or use
// copy-on-select: tests must explicitly supply a fake clipboard backend.
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { createSelectionCopySystem } from "../../src/selection-copy/index.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { SelectionSerializer } from "../../src/selection-copy/serialize.ts";
import { fakeTerminal, sgr } from "../helpers.mjs";

export const markdownTheme = {
  ...Object.fromEntries([
    "bold", "italic", "underline", "strikethrough", "heading", "code", "codeBlock",
    "codeBlockBorder", "listBullet", "quote", "quoteBorder", "hr", "link", "linkUrl",
  ].map((name) => [name, (text) => text])),
  codeBlockIndent: "  ",
};
export function container(...children) {
  const root = new Tui.Container();
  children.forEach((child) => root.addChild(child));
  return root;
}

export function altScreen(width = 80, rows = 24) {
  const terminal = fakeTerminal(width, rows);
  const tui = new Tui.TuiAltScreen(terminal);
  assert.equal(tui.copySelection, undefined, "no system clipboard backend, even under local WSL");
  tui.requestRender = () => {};
  tui.beforeTerminalStart();
  tui.setCopyOnSelect(false);
  return { tui, terminal };
}

export const screenLines = (tui) =>
  tui.previousScreen.map((line) => Tui.stripTerminalSequences(line).trimEnd());

/** Coordinates are one-based terminal cells, not JavaScript string offsets. */
export function drag(tui, startX, startY, endX, endY) {
  tui.handleTerminalInput(sgr(0, startX, startY));
  tui.handleTerminalInput(sgr(32, endX, endY));
  tui.handleTerminalInput(sgr(0, endX, endY, true));
}

/** Each test owns session resources; render wrappers remain installed for the process. */
export function installCopyPrototypes(t, names = ["Text", "Markdown", "Box", "Container"], fns = {}) {
  const system = createSelectionCopySystem({
    prototypes: Object.fromEntries(names.map((name) => [name, Tui[name].prototype])),
    fns: { ...Tui, renderLatex: (text, options) => Tui.renderLatex(text, options) ?? null, ...fns },
  });
  t.after(() => system.dispose());
  system.wrapPrototypes();
  return system;
}

export function copyFrame(component, width) {
  const lines = component.render(width);
  assert.ok(productFor(lines), "render publishes a copy product");
  const rect = { x: 0, y: 0, width, height: lines.length };
  return { root: { component, rect, clip: rect, children: [], lines } };
}

export function select(frame, startRow = 0, endRow, columnsFor) {
  const { root } = frame;
  const sourceLines = root.scrollContentLines ?? root.lines;
  return new SelectionSerializer(Tui).serialize(frame, {
    scrollView: root.scrollView, sourceLines, startRow,
    endRow: endRow ?? sourceLines.length - 1,
    columnsFor: columnsFor ?? ((row) => ({ start: 0, end: Tui.visibleWidth(sourceLines[row] ?? "") })),
  });
}
