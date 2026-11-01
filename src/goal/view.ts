import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, Editor, ScrollView, Text, getCapabilities, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { formatElapsedSeconds, type Goal, type GoalControlAction, type GoalStatus } from "./state.ts";
import { safeText } from "../presentation/terminal-text.ts";
import {
  backgroundAnsi, CODEMODE_ORANGE, DARK_SURFACE_BG, FG_DEFAULT, foregroundAnsi, resolveColorContext,
} from "../presentation/palette.ts";
import { paintSurfaceBackground } from "../presentation/sgr.ts";

// Native Editor wrapping needs room for a wide grapheme plus its two padding cells.
const EDITOR_MIN_WIDTH = 4;
type Action = "edit" | "cancel" | "save" | "close" | GoalControlAction;
interface GoalPopupOptions {
  save: (objective: string, original: string) => void;
  control: (action: GoalControlAction) => void;
  done: () => void;
  signal: AbortSignal;
}
const STATUS: Record<GoalStatus, string> = {
  active: "Pursuing", paused: "Paused", blocked: "Blocked", complete: "Completed",
  usageLimited: "Usage limited", budgetLimited: "Budget limited",
};

/** UI controls are narrower than slash commands: clearing requires an explicit pause or completion. */
export function goalPopupControls(status: GoalStatus): GoalControlAction[] {
  if (status === "active") return ["pause"];
  if (status === "paused") return ["resume", "clear"];
  if (status === "complete") return ["clear"];
  return ["pause", "resume"];
}

export class GoalPopup implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private goal: Goal;
  private options: GoalPopupOptions;
  private editor: Editor;
  private text: Text;
  private reader: ScrollView;
  private original?: string;
  private error?: string;
  private hasFocus = false;
  private disposed = false;
  private bodyTop = 0;
  private bodyHeight = 0;
  private editorClip = 0;
  private editorHeight = 0;
  private pageSize = 1;
  private contentLeft = 0;
  private contentWidth = 1;
  private readonly rail: string;
  private readonly background: string;
  private targets: Array<{ action: Action; x: number; y: number; width: number }> = [];
  private requestRender = () => this.tui.requestRender();
  private onAbort = () => this.close();

  constructor(tui: TUI, theme: Theme, goal: Goal, options: GoalPopupOptions) {
    this.tui = tui; this.theme = theme; this.goal = goal; this.options = options;
    const colorLevel = resolveColorContext({ terminalTrueColor: getCapabilities().trueColor });
    const orange = foregroundAnsi(CODEMODE_ORANGE, colorLevel);
    this.rail = orange ? `${orange}▏${FG_DEFAULT}` : "▏";
    this.background = backgroundAnsi(DARK_SURFACE_BG, colorLevel);
    this.text = new Text(safeText(goal.objective), 0, 0);
    this.reader = new ScrollView(this.text, { scrollbar: "hidden" });
    this.editor = new Editor(tui, {
      borderColor: text => theme.fg("border", text), selectList: getSelectListTheme(),
    }, { paddingX: 1 });
    this.editor.disableSubmit = true;
    options.signal.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal.aborted) this.close();
  }

  private get editing() { return this.original !== undefined; }
  private get actions(): Action[] {
    return this.editing ? ["edit", "cancel", "save"] : ["edit", ...goalPopupControls(this.goal.status)];
  }

  get focused() { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && this.editing;
  }

  update(goal: Goal | null): void {
    if (this.disposed) return;
    if (!goal || goal.id !== this.goal.id) { this.close(); return; }
    if (goal.objective !== this.goal.objective) this.text.setText(safeText(goal.objective));
    this.goal = goal;
    this.requestRender();
  }

  private activate(action: Action): void {
    if (this.disposed) return;
    if (action === "close") { this.close(); return; }
    if (!this.actions.includes(action)) return;
    if (action === "pause" || action === "resume" || action === "clear") {
      try { this.error = undefined; this.options.control(action); }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      if (!this.disposed) this.requestRender();
      return;
    }
    if (action === "edit") {
      if (!this.editing) {
        this.original = this.goal.objective;
        this.editor.setText(safeText(this.original));
        this.error = undefined;
      }
    } else {
      if (action === "save") {
        try { this.options.save(this.editor.getExpandedText(), this.original!); }
        catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
          this.requestRender();
          return;
        }
      }
      this.original = undefined;
      this.error = undefined;
    }
    this.tui.setFocus(this);
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape")) this.activate(this.editing ? "cancel" : "close");
    else if (matchesKey(data, "ctrl+c")) this.close();
    else if (!this.editing && matchesKey(data, "ctrl+e")) this.activate("edit");
    else if (this.editing) {
      if (matchesKey(data, "ctrl+s")) this.activate("save");
      else if (matchesKey(data, "enter")) this.editor.insertTextAtCursor("\n");
      else this.editor.handleInput(data);
    } else if (matchesKey(data, "home")) this.reader.scrollToStart();
    else if (matchesKey(data, "end")) this.reader.scrollToEnd();
    else if (matchesKey(data, "up")) this.reader.scrollBy(-1);
    else if (matchesKey(data, "down")) this.reader.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.reader.scrollBy(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.reader.scrollBy(this.pageSize);
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.disposed) return;
    const target = this.targets.find(t => event.y === t.y && event.x >= t.x && event.x < t.x + t.width);
    if (target && event.button === "left") {
      if (event.type === "click") this.activate(target.action);
      if (event.type === "press" || event.type === "release" || event.type === "click") return { handled: true };
    }
    const y = event.y - this.bodyTop;
    if (y < 0 || y >= this.bodyHeight) return;
    if (this.editing) {
      const x = event.x - this.contentLeft;
      if (x < 0 || x >= this.contentWidth) return;
      return this.editor.handleMouse({ ...event, x, y: y + this.editorClip,
        width: Math.max(EDITOR_MIN_WIDTH, this.contentWidth), height: this.editorHeight });
    }
    if (event.type === "wheel") {
      this.reader.scrollBy(event.wheelDelta ?? 0);
      return { handled: true };
    }
  }

  render(width: number): string[] {
    this.targets = []; this.bodyHeight = 0;
    if (this.disposed || width <= 0) return [];
    // Same viewer insets: rail + left space, a spare body column, and trailing padding.
    const framed = width >= 5;
    this.contentLeft = framed ? 2 : 0;
    this.contentWidth = framed ? width - 4 : width;
    const headerWidth = framed ? width - 3 : width;
    const close = truncateToWidth("[X]", headerWidth, "");
    const title = truncateToWidth("Goal", Math.max(0, headerWidth - visibleWidth(close) - 1), "");
    const x = headerWidth - visibleWidth(close);
    const lines = [this.theme.fg("accent", title) + " ".repeat(x - visibleWidth(title)) + this.theme.fg("accent", close),
      truncateToWidth(`${STATUS[this.goal.status]} · Elapsed: ${formatElapsedSeconds(this.goal.timeUsedSeconds)}`, this.contentWidth, "…")];
    this.targets.push({ action: "close", x: x + this.contentLeft, y: 0, width: visibleWidth(close) });
    let row = "";
    for (const action of this.actions) {
      const name = action === "edit" && this.editing ? "Editing" : action.charAt(0).toUpperCase() + action.slice(1);
      const label = `[${name}]`;
      if (row && visibleWidth(row) + label.length + 1 > this.contentWidth) { lines.push(row); row = ""; }
      const x = visibleWidth(row) + (row ? 1 : 0);
      const text = truncateToWidth(label, Math.max(0, this.contentWidth - x), "");
      this.targets.push({ action, x: x + this.contentLeft, y: lines.length, width: visibleWidth(text) });
      row += (row ? " " : "") + this.theme.fg("accent", text);
    }
    lines.push(row, "");
    // Match the subagent overlay: reserve 70% of terminal rows, including empty body rows.
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    this.bodyTop = lines.length;
    this.pageSize = Math.max(0, height - this.bodyTop - 1);
    // Overlays call render() directly, without native layout allocating a viewport.
    const body = this.editing ? this.editor.render(Math.max(EDITOR_MIN_WIDTH, this.contentWidth)) : this.reader.render(this.contentWidth);
    if (!this.editing) this.reader.updateLayout(body.length, this.pageSize, this.requestRender);
    this.editorHeight = body.length;
    const cursor = this.editing ? body.findIndex(line => line.includes(CURSOR_MARKER)) : -1;
    this.editorClip = Math.max(0, cursor - this.pageSize + 1);
    const offset = this.editing ? this.editorClip : this.reader.scrollTop;
    const visible = body.slice(offset, offset + this.pageSize);
    this.bodyHeight = visible.length;
    while (visible.length < this.pageSize) visible.push("");
    lines.push(...visible, this.theme.fg(this.error ? "error" : "dim", safeText(this.error ??
      (this.editing ? "Ctrl+S Save · Esc Cancel" : "Ctrl+E Edit · Esc Close"))));
    const output = lines.slice(0, height).map((line, index) => {
      const text = truncateToWidth(line, index === 0 ? headerWidth : this.contentWidth, "");
      const row = framed ? `${this.rail} ${text}${" ".repeat(headerWidth - visibleWidth(text))} ` : text;
      return paintSurfaceBackground(row + " ".repeat(Math.max(0, width - visibleWidth(row))), this.background);
    });
    this.targets = this.targets.filter(target => target.y < output.length);
    return output;
  }

  invalidate(): void { this.reader.invalidate(); this.editor.invalidate(); }
  private close(): void { if (!this.disposed) { this.dispose(); this.options.done(); } }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editor.focused = false;
    this.targets = []; this.bodyHeight = 0;
    this.options.signal.removeEventListener("abort", this.onAbort);
  }
}
