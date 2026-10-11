import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type AppearanceConfig } from "../config.ts";
import { ViewerContent, cleanViewerText as clean, type ViewerMessage } from "./viewer-content.ts";

export interface AgentInspection {
  agent: {
    name?: string;
    state: string;
    cwd?: string;
    resolved_model?: { provider: string; id: string };
    active_tools?: string[];
  };
  messages: Array<{ id: string; message: ViewerMessage }>;
  session_file: string;
  reset?: boolean;
  next_cursor: number;
  has_more: boolean;
  history_pruned?: boolean;
  run?: { state: string; error?: string };
}

/** Read-only, bounded conversation view. Opening it never consumes attention or ACKs a result. */
export class SubagentViewer implements Component {
  private snapshot?: AgentInspection;
  private readonly content: ViewerContent;
  private file = "";
  private cursor = 0;
  private truncated = false;
  private error = "";
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private offset = Infinity;
  private maxOffset = 0;
  private pageSize = 1;
  private cachedWidth = -1;
  private lines: string[] = [];
  private layout: Array<{ component: Component; y: number; height: number }> = [];
  private renderedOffset = 0;
  private bodyTop = 5;
  private innerWidth = 1;
  private readonly onAbort: () => void;
  private readonly agentId: string;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly keys: KeybindingsManager;
  private readonly done: (value: undefined) => void;
  private readonly abort: AbortController;
  private readonly inspect: (after: number) => Promise<AgentInspection>;

  constructor(
    agentId: string,
    theme: Theme,
    tui: TUI,
    keys: KeybindingsManager,
    done: (value: undefined) => void,
    abort: AbortController,
    inspect: (after: number) => Promise<AgentInspection>,
    thinking: AppearanceConfig["thinking"] = DEFAULT_CONFIG.thinking,
  ) {
    this.agentId = agentId; this.theme = theme; this.tui = tui; this.keys = keys;
    this.done = done; this.abort = abort; this.inspect = inspect;
    this.content = new ViewerContent(theme, tui, thinking, () => { this.invalidate(); this.tui.requestRender(); });
    this.onAbort = () => done(undefined);
    abort.signal.addEventListener("abort", this.onAbort, { once: true });
    if (abort.signal.aborted) this.onAbort();
    else void this.refresh();
  }

  private async refresh() {
    let more = false;
    try {
      const snapshot = await this.inspect(this.cursor);
      if (this.disposed || this.abort.signal.aborted) return;
      if (snapshot.reset || (this.file && this.file !== snapshot.session_file)) {
        this.content.dispose(); this.offset = Infinity; this.truncated = false;
        this.cursor = 0; this.file = snapshot.session_file; this.invalidate(); more = true; return;
      }
      this.file = snapshot.session_file;
      this.snapshot = snapshot; this.cursor = snapshot.next_cursor; more = snapshot.has_more;
      if (snapshot.history_pruned) this.truncated = true;
      for (const entry of snapshot.messages) this.content.append(entry.message, snapshot.agent.cwd ?? "");
      this.truncated ||= this.content.truncated;
      this.error = ""; this.invalidate();
    } catch (error) {
      if (this.disposed || this.abort.signal.aborted) return;
      this.error = clean(String(error));
    } finally {
      if (!this.disposed && !this.abort.signal.aborted) {
        this.tui.requestRender();
        this.timer = setTimeout(() => void this.refresh(), more ? 50 : 1000);
      }
    }
  }

  private scroll(delta: number) {
    const offset = Number.isFinite(this.offset) ? this.offset : this.maxOffset;
    this.offset = Math.max(0, Math.min(this.maxOffset, offset + delta));
    if (this.offset === this.maxOffset) this.offset = Infinity;
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c") || data === "q")
      this.done(undefined);
    else if (this.keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
    else if (matchesKey(data, "home")) {
      this.offset = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "end")) {
      this.offset = Infinity;
      this.tui.requestRender();
    } else if (this.keys.matches(data, "app.tools.expand")) {
      this.offset = this.renderedOffset;
      this.content.toggleTools();
      this.invalidate();
      this.tui.requestRender();
    } else if (this.keys.matches(data, "app.thinking.toggle")) {
      this.offset = this.renderedOffset;
      this.content.toggleThinking();
      this.invalidate();
      this.tui.requestRender();
    }
  }

  handleMouse(event: TuiMouseEvent) {
    const bodyY = event.y - this.bodyTop;
    const padding = this.bodyTop === 5 ? 2 : 0;
    if (bodyY >= 0 && bodyY < this.pageSize && event.x >= padding && event.x < padding + this.innerWidth) {
      const y = bodyY + this.renderedOffset;
      const item = this.layout.find(item => y >= item.y && y < item.y + item.height);
      const previous = this.offset;
      if (event.type === "click") this.offset = this.renderedOffset;
      const result = item?.component.handleMouse?.({ ...event, x: event.x - padding,
        y: y - item.y, width: this.innerWidth, height: item.height });
      if (result?.handled) { this.invalidate(); this.tui.requestRender(); return { handled: true, requestRender: true }; }
      this.offset = previous;
    }
    if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true, requestRender: true }; }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const inner = Math.max(1, width - 4);
    this.innerWidth = inner; this.bodyTop = width < 5 ? 4 : 5;
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    this.pageSize = Math.max(1, height - 7);
    if (inner !== this.cachedWidth) {
      this.lines = []; this.layout = [];
      for (const entry of this.content.entries) {
        const lines = entry.component.render(inner);
        this.layout.push({ component: entry.component, y: this.lines.length, height: lines.length });
        this.lines.push(...lines, "");
      }
      if (!this.lines.length) this.lines.push("Waiting for completed messages…");
      this.cachedWidth = inner;
    }
    this.maxOffset = Math.max(0, this.lines.length - this.pageSize);
    const offset = Math.min(this.offset, this.maxOffset);
    this.renderedOffset = offset;
    const agent = this.snapshot?.agent;
    const model = agent?.resolved_model;
    const toolsKey = this.keys.getKeys("app.tools.expand").join("/");
    const thoughtsKey = this.keys.getKeys("app.thinking.toggle").join("/");
    const body = this.lines.slice(offset, offset + this.pageSize);
    while (body.length < this.pageSize) body.push("");
    const content = [
      this.theme.fg("accent", `Subagent: ${clean(agent?.name ?? this.agentId)}`),
      clean(
        `${agent?.state ?? "loading"}` +
          " · run " +
          `${this.snapshot?.run?.state ?? "—"}` +
          `${agent?.active_tools?.length ? ` · tools: ${agent.active_tools.join(", ")}` : ""}`,
      ),
      this.theme.fg("muted", clean(`${model ? `${model.provider}/${model.id} · ` : ""}${agent?.cwd ?? ""}`)),
      this.theme.fg(
        this.error || this.snapshot?.run?.error ? "error" : "dim",
        this.error ||
          clean(this.snapshot?.run?.error ?? "") ||
          (this.truncated ? "Some history omitted" : "Click tools or thoughts to expand/collapse"),
      ),
      ...body,
      this.theme.fg("muted", `Click to fold · ${toolsKey} tools · ${thoughtsKey} thoughts · ↑/↓ scroll · Esc close`),
    ];
    if (width < 5) return content.slice(0, height).map((line) => truncateToWidth(line.replace(/\n/g, " "), width, "…"));
    const border = (text: string) => this.theme.fg("border", text);
    return [
      border(`╭${"─".repeat(width - 2)}╮`),
      ...content.map((line) => {
        const text = truncateToWidth(line.replace(/\n/g, " "), inner, "…");
        return `${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border("│")}`;
      }),
      border(`╰${"─".repeat(width - 2)}╯`),
    ].slice(0, height);
  }

  invalidate() {
    this.cachedWidth = -1;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.content.dispose();
    this.layout = [];
    this.lines = [];
    this.abort.signal.removeEventListener("abort", this.onAbort);
    this.abort.abort();
  }
}
