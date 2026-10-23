import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, Editor, ScrollView, Text, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { formatElapsedSeconds, type Goal, type GoalStatus } from "./state.ts";
import { safeText } from "../presentation/terminal-text.ts";

// Native Editor wrapping needs room for a wide grapheme plus its two padding cells.
const EDITOR_MIN_WIDTH = 4;
type Action = "edit" | "cancel" | "save" | "close" | "pause" | "resume";
interface GoalPopupOptions {
  save: (objective: string, original: string) => void;
  setStatus: (status: "active" | "paused") => void;
  done: () => void;
  signal: AbortSignal;
}
const STATUS: Record<GoalStatus, string> = {
  active: "Pursuing", paused: "Paused", blocked: "Blocked", complete: "Completed",
  usageLimited: "Usage limited", budgetLimited: "Budget limited",
};

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
  private bodyPadding = 0;
  private innerWidth = 1;
  private scrollbar?: { top: number; height: number };
  private scrollbarGrab?: number;
  private editorClip = 0;
  private contentHeight = 0;
  private pageSize = 1;
  private targets: Array<{ action: Action; x: number; y: number; width: number }> = [];
  private requestRender = () => this.tui.requestRender();
  private onAbort = () => this.close();

  constructor(tui: TUI, theme: Theme, goal: Goal, options: GoalPopupOptions) {
    this.tui = tui; this.theme = theme; this.goal = goal; this.options = options;
    this.text = new Text(safeText(goal.objective), 0, 0);
    // The overlay paints its frame scrollbar; ScrollView owns the read position.
    this.reader = new ScrollView(this.text, { scrollbar: "hidden" });
    this.editor = new Editor(tui, {
      borderColor: text => theme.fg("border", text), selectList: getSelectListTheme(),
    }, { paddingX: 1 });
    this.editor.disableSubmit = true;
    options.signal.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal.aborted) this.close();
  }

  private get editing() { return this.original !== undefined; }
  private get statusAction(): "pause" | "resume" | undefined {
    if (this.goal.status === "active") return "pause";
    if (["paused", "blocked", "usageLimited"].includes(this.goal.status)) return "resume";
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
    if (action === "pause" || action === "resume") {
      if (this.editing || action !== this.statusAction) return;
      try {
        this.options.setStatus(action === "pause" ? "paused" : "active");
        this.error = undefined;
      } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      this.requestRender();
      return;
    }
    if ((action === "save" || action === "cancel") && !this.editing) return;
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
    else if (!this.editing && matchesKey(data, "ctrl+p") && this.statusAction) this.activate(this.statusAction);
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

  private scrollScrollbarTo(y: number, grab: number): void {
    if (!this.scrollbar || this.pageSize <= this.scrollbar.height) return;
    const maxOffset = Math.max(0, this.contentHeight - this.pageSize);
    this.reader.scrollTo(Math.round((y - this.bodyTop - grab) * maxOffset / (this.pageSize - this.scrollbar.height)));
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.disposed) return;
    if (event.type === "press") this.scrollbarGrab = undefined;
    if (this.scrollbarGrab !== undefined) {
      if (event.type === "release") { this.scrollbarGrab = undefined; return { handled: true }; }
      if (event.type === "drag") {
        this.scrollScrollbarTo(event.y, this.scrollbarGrab);
        return { handled: true, render: true };
      }
    }
    const target = this.targets.find(t => event.y === t.y && event.x >= t.x && event.x < t.x + t.width);
    if (target && event.button === "left") {
      if (event.type === "click") this.activate(target.action);
      if (event.type === "press" || event.type === "release" || event.type === "click") return { handled: true };
    }
    const y = event.y - this.bodyTop;
    if (y < 0 || y >= this.bodyHeight) return;
    const thumb = this.scrollbar;
    if (thumb && event.x === this.innerWidth + 3 && event.button === "left"
      && (event.type === "press" || event.type === "click")) {
      const onThumb = y >= thumb.top && y < thumb.top + thumb.height;
      const grab = onThumb ? y - thumb.top : Math.floor(thumb.height / 2);
      if (event.type === "press") this.scrollbarGrab = grab;
      if (!onThumb) this.scrollScrollbarTo(event.y, grab);
      return { handled: true, capture: event.type === "press" };
    }
    if (this.editing) {
      return this.editor.handleMouse({ ...event, x: event.x - this.bodyPadding, y: y + this.editorClip,
        width: Math.max(EDITOR_MIN_WIDTH, this.innerWidth), height: this.contentHeight });
    }
    if (event.type === "wheel") {
      this.reader.scrollBy(event.wheelDelta ?? 0);
      return { handled: true };
    }
  }

  render(width: number): string[] {
    this.targets = []; this.bodyHeight = 0; this.scrollbar = undefined;
    if (this.disposed || width <= 0) { this.scrollbarGrab = undefined; return []; }
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    const bordered = width >= 5 && height >= 2, frameRows = bordered ? 2 : 0;
    const inner = bordered ? width - 4 : width;
    this.innerWidth = inner; this.bodyPadding = bordered ? 2 : 0;
    const close = truncateToWidth("[X]", inner, "");
    const title = truncateToWidth("Goal", Math.max(0, inner - visibleWidth(close) - 1), "");
    const x = inner - visibleWidth(close);
    const lines = [this.theme.fg("accent", title) + " ".repeat(x - visibleWidth(title)) + this.theme.fg("accent", close),
      truncateToWidth(`${STATUS[this.goal.status]} · Elapsed: ${formatElapsedSeconds(this.goal.timeUsedSeconds)}`, inner, "…")];
    this.targets.push({ action: "close", x, y: 0, width: visibleWidth(close) });
    const actions: Action[] = this.editing ? ["edit", "cancel", "save"] : ["edit", ...(this.statusAction ? [this.statusAction] : [])];
    let row = "";
    for (const action of actions) {
      const label = `[${action === "edit" ? this.editing ? "Editing" : "Edit" : action[0].toUpperCase() + action.slice(1)}]`;
      if (row && visibleWidth(row) + label.length + 1 > inner) { lines.push(row); row = ""; }
      const x = visibleWidth(row) + (row ? 1 : 0);
      const text = truncateToWidth(label, Math.max(0, inner - x), "");
      this.targets.push({ action, x, y: lines.length, width: visibleWidth(text) });
      row += (row ? " " : "") + this.theme.fg("accent", text);
    }
    lines.push(row);
    this.bodyTop = lines.length + (bordered ? 1 : 0);
    this.pageSize = Math.max(0, height - frameRows - lines.length - 1);
    // Overlays call render() directly, without native layout allocating a viewport.
    const body = this.editing ? this.editor.render(Math.max(EDITOR_MIN_WIDTH, inner)) : this.reader.render(inner);
    if (!this.editing) this.reader.updateLayout(body.length, this.pageSize, this.requestRender);
    this.contentHeight = body.length;
    const cursor = this.editing ? body.findIndex(line => line.includes(CURSOR_MARKER)) : -1;
    this.editorClip = Math.max(0, cursor - this.pageSize + 1);
    const offset = this.editing ? this.editorClip : this.reader.scrollTop;
    const visible = body.slice(offset, offset + this.pageSize);
    this.bodyHeight = this.pageSize;
    if (bordered && !this.editing && this.pageSize > 0 && body.length > this.pageSize) {
      const height = Math.max(Math.min(2, this.pageSize), Math.round(this.pageSize ** 2 / body.length));
      this.scrollbar = { height, top: Math.round((this.pageSize - height) * offset / (body.length - this.pageSize)) };
    } else this.scrollbarGrab = undefined;
    while (visible.length < this.pageSize) visible.push("");
    const statusHint = this.statusAction ? ` · Ctrl+P ${this.statusAction === "pause" ? "Pause" : "Resume"}` : "";
    lines.push(...visible, this.theme.fg(this.error ? "error" : "dim", safeText(this.error ??
      (this.editing ? "Ctrl+S Save · Esc Cancel" : `Ctrl+E Edit${statusHint} · ↑/↓ Scroll · Esc Close`))));
    const content = lines.slice(0, Math.max(0, height - frameRows));
    const border = (text: string) => this.theme.fg("border", text);
    const output = bordered ? [
      border(`╭${"─".repeat(width - 2)}╮`),
      ...content.map((line, index) => {
        const text = truncateToWidth(line, inner, ""), y = index + 1 - this.bodyTop;
        const thumb = this.scrollbar;
        const edge = thumb && y >= thumb.top && y < thumb.top + thumb.height ? this.theme.fg("accent", "┃") : border("│");
        return `${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${edge}`;
      }),
      border(`╰${"─".repeat(width - 2)}╯`),
    ] : content.map(line => truncateToWidth(line, width, ""));
    this.targets = this.targets.filter(target => target.y < content.length)
      .map(target => ({ ...target, x: target.x + this.bodyPadding, y: target.y + (bordered ? 1 : 0) }));
    return output;
  }

  invalidate(): void { this.reader.invalidate(); this.editor.invalidate(); }
  private close(): void { if (!this.disposed) { this.dispose(); this.options.done(); } }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editor.focused = false;
    this.targets = []; this.bodyHeight = 0;
    this.scrollbar = undefined; this.scrollbarGrab = undefined;
    this.options.signal.removeEventListener("abort", this.onAbort);
  }
}
