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
import { DEFAULT_CONFIG, type AppearanceConfig } from "../../appearance/config.ts";
import { ViewerContent, cleanViewerText as clean, type ViewerMessage } from "./viewer-content.ts";
import { activeAgents } from "./widget.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";

export interface AgentInspection {
  agent: {
    name?: string;
    state: string;
    cwd?: string;
    resolved_model?: { provider: string; id: string };
    thinking?: string;
    active_tools?: string[];
  };
  messages: Array<{ id: string; message: ViewerMessage }>;
  tool_renderers?: Record<string, ToolPresentation>;
  session_file: string;
  reset?: boolean;
  next_cursor: number;
  has_more: boolean;
  history_pruned?: boolean;
  run?: { state: string; error?: string };
}

export interface ViewerAgent { id: string; name: string; state: string }
interface AgentView {
  content: ViewerContent;
  snapshot?: AgentInspection;
  file: string;
  cursor: number;
  truncated: boolean;
  error: string;
  offset: number;
  maxOffset: number;
  renderedOffset: number;
  cachedWidth: number;
  lines: string[];
  layout: Array<{ component: Component; y: number; height: number }>;
}
interface HeaderTarget { x: number; y: number; width: number; activate: () => void }
const MAX_CACHED_VIEWS = 8;

function disposeView(view: AgentView) {
  view.content.dispose(); view.lines = []; view.layout = []; view.snapshot = undefined;
}

/** Read-only, bounded conversation view. Opening it never consumes attention or ACKs a result. */
export class SubagentViewer implements Component {
  private readonly views = new Map<string, AgentView>();
  private agents = new Map<string, ViewerAgent>();
  private agentId: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readAbort = new AbortController();
  private disposed = false;
  private pageSize = 1;
  private bodyTop = 3;
  private bodyPadding = 2;
  private innerWidth = 1;
  private renderedHeight = 0;
  private scrollbar?: { top: number; height: number };
  private scrollbarGrab?: number;
  private targets: HeaderTarget[] = [];
  private tabStart = 0;
  private tabWidth = -1;
  private revealSelected = true;
  private readonly onAbort: () => void;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly keys: KeybindingsManager;
  private readonly done: (value: undefined) => void;
  private readonly abort: AbortController;
  private readonly inspect: (agentId: string, after: number, signal: AbortSignal) => Promise<AgentInspection>;
  private readonly appearance: AppearanceConfig;
  private readonly agentSource: () => ViewerAgent[];
  private readonly live: boolean;

  constructor(
    agentId: string,
    theme: Theme,
    tui: TUI,
    keys: KeybindingsManager,
    done: (value: undefined) => void,
    abort: AbortController,
    inspect: (agentId: string, after: number, signal: AbortSignal) => Promise<AgentInspection>,
    appearance: AppearanceConfig = DEFAULT_CONFIG,
    agentSource: () => ViewerAgent[],
    live = true,
  ) {
    this.agentId = agentId; this.theme = theme; this.tui = tui; this.keys = keys;
    this.done = done; this.abort = abort; this.inspect = inspect;
    this.appearance = appearance; this.agentSource = agentSource; this.live = live;
    this.cacheView(agentId);
    this.onAbort = () => this.close();
    abort.signal.addEventListener("abort", this.onAbort, { once: true });
    if (abort.signal.aborted) this.onAbort();
    else void this.refresh(this.view, this.readAbort);
  }

  private syncAgents(): boolean {
    if (this.disposed) return false;
    const source = this.agentSource();
    const visible = new Map((this.live ? activeAgents(source) : source).map(agent => [agent.id, agent]));
    const changed = visible.size !== this.agents.size || [...visible.keys()].some(id => !this.agents.has(id));
    this.agents = visible;
    for (const [id, view] of this.views) {
      if (!visible.has(id)) { disposeView(view); this.views.delete(id); }
    }
    if (!visible.size) { this.close(); return false; }
    if (changed) {
      this.targets = []; this.renderedHeight = 0; this.revealSelected = true;
      this.tui.requestRender();
    }
    if (!visible.has(this.agentId)) this.selectAgent(visible.keys().next().value!);
    return true;
  }

  private get view(): AgentView {
    return this.views.get(this.agentId)!;
  }

  private cacheView(id: string) {
    let view = this.views.get(id);
    if (view) this.views.delete(id);
    else {
      const state: AgentView = {
        content: new ViewerContent(this.theme, this.tui, this.appearance, () => {
          state.cachedWidth = -1;
          if (!this.disposed && this.view === state) this.tui.requestRender();
        }),
        file: "", cursor: 0, truncated: false, error: "", offset: Infinity,
        maxOffset: 0, renderedOffset: 0, cachedWidth: -1, lines: [], layout: [],
      };
      view = state;
    }
    this.views.set(id, view);
    if (this.views.size > MAX_CACHED_VIEWS) {
      const oldest = this.views.keys().next().value!;
      disposeView(this.views.get(oldest)!);
      this.views.delete(oldest);
    }
  }

  private selectAgent(id: string) {
    if (this.disposed || id === this.agentId || !this.agents.has(id)) return;
    clearTimeout(this.timer);
    this.readAbort.abort();
    this.readAbort = new AbortController();
    this.agentId = id;
    this.cacheView(id);
    this.revealSelected = true;
    this.targets = []; this.renderedHeight = 0;
    this.scrollbar = undefined; this.scrollbarGrab = undefined;
    this.tui.requestRender();
    void this.refresh(this.view, this.readAbort);
  }

  private cycleAgent(delta: number) {
    const ids = [...this.agents.keys()];
    const index = ids.indexOf(this.agentId);
    this.selectAgent(ids[(index + delta + ids.length) % ids.length]);
  }

  private async refresh(view: AgentView, controller: AbortController) {
    const current = () => !this.disposed && !controller.signal.aborted && this.readAbort === controller;
    if (!current() || !this.syncAgents() || !current()) return;
    let more = false;
    try {
      const snapshot = await this.inspect(this.agentId, view.cursor, controller.signal);
      if (!current() || !this.syncAgents() || !current()) return;
      if (snapshot.reset || (view.file && view.file !== snapshot.session_file)) {
        view.content.dispose(); view.offset = Infinity; view.truncated = false;
        view.cursor = 0; view.file = snapshot.session_file; view.cachedWidth = -1; more = true; return;
      }
      view.file = snapshot.session_file;
      view.snapshot = snapshot; view.cursor = snapshot.next_cursor; more = snapshot.has_more;
      if (snapshot.agent.name) this.agents.set(this.agentId, { ...this.agents.get(this.agentId)!, name: snapshot.agent.name });
      if (snapshot.history_pruned) view.truncated = true;
      view.content.setToolRenderers(snapshot.tool_renderers ?? {});
      for (const entry of snapshot.messages) view.content.append(entry.message, snapshot.agent.cwd ?? "");
      view.truncated ||= view.content.truncated;
      view.error = ""; view.cachedWidth = -1;
    } catch (error) {
      if (!current()) return;
      view.error = clean(String(error));
    } finally {
      if (current()) {
        this.tui.requestRender();
        if (more || this.live) this.timer = setTimeout(() => void this.refresh(view, controller), more ? 50 : 1000);
      }
    }
  }

  private close() {
    if (this.disposed) return;
    this.dispose();
    this.done(undefined);
  }

  private scroll(delta: number) {
    const view = this.view;
    const offset = Number.isFinite(view.offset) ? view.offset : view.maxOffset;
    view.offset = Math.max(0, Math.min(view.maxOffset, offset + delta));
    if (view.offset === view.maxOffset) view.offset = Infinity;
    this.tui.requestRender();
  }

  private scrollScrollbarTo(y: number, grab: number) {
    if (!this.scrollbar || this.pageSize <= this.scrollbar.height) return;
    const view = this.view;
    const target = Math.round((y - this.bodyTop - grab) * view.maxOffset / (this.pageSize - this.scrollbar.height));
    const current = Number.isFinite(view.offset) ? view.offset : view.maxOffset;
    this.scroll(target - current);
  }

  handleInput(data: string) {
    if (!this.syncAgents()) return;
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c") || data === "q") this.close();
    else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.cycleAgent(-1);
    else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.cycleAgent(1);
    else if (this.keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
    else if (matchesKey(data, "home")) {
      this.view.offset = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "end")) {
      this.view.offset = Infinity;
      this.tui.requestRender();
    } else if (this.keys.matches(data, "app.tools.expand")) {
      this.view.offset = this.view.renderedOffset;
      this.view.content.toggleTools();
      this.invalidate();
      this.tui.requestRender();
    } else if (this.keys.matches(data, "app.thinking.toggle")) {
      this.view.offset = this.view.renderedOffset;
      this.view.content.toggleThinking();
      this.invalidate();
      this.tui.requestRender();
    }
  }

  handleMouse(event: TuiMouseEvent) {
    if (!this.syncAgents()) return;
    if (event.type === "press") this.scrollbarGrab = undefined;
    if (this.scrollbarGrab !== undefined) {
      if (event.type === "release") { this.scrollbarGrab = undefined; return { handled: true }; }
      if (event.type === "drag") {
        this.scrollScrollbarTo(event.y, this.scrollbarGrab);
        return { handled: true, render: true };
      }
    }
    if (event.y < 0 || event.y >= this.renderedHeight) return;
    const target = this.targets.find(target => event.y === target.y && event.x >= target.x && event.x < target.x + target.width);
    if (target && event.button === "left") {
      if (event.type === "click") {
        target.activate();
        return { handled: true, requestRender: true };
      }
      if (event.type === "press" || event.type === "release") return { handled: true };
    }
    const view = this.view;
    const bodyY = event.y - this.bodyTop;
    const thumb = this.scrollbar;
    if (thumb && event.x === this.innerWidth + 3 && bodyY >= 0 && bodyY < this.pageSize &&
        event.button === "left" && (event.type === "press" || event.type === "click")) {
      const onThumb = bodyY >= thumb.top && bodyY < thumb.top + thumb.height;
      const grab = onThumb ? bodyY - thumb.top : Math.floor(thumb.height / 2);
      if (event.type === "press") this.scrollbarGrab = grab;
      if (!onThumb) this.scrollScrollbarTo(event.y, grab);
      return { handled: true, capture: event.type === "press" };
    }
    if (bodyY >= 0 && bodyY < this.pageSize && event.x >= this.bodyPadding && event.x < this.bodyPadding + this.innerWidth) {
      const y = bodyY + view.renderedOffset;
      const item = view.layout.find(item => y >= item.y && y < item.y + item.height);
      const previous = view.offset;
      if (event.type === "click") view.offset = view.renderedOffset;
      const result = item?.component.handleMouse?.({ ...event, x: event.x - this.bodyPadding,
        y: y - item.y, width: this.innerWidth, height: item.height });
      if (result?.handled || result?.render) {
        if (event.type === "press" && result.render) view.offset = view.renderedOffset;
        this.invalidate(); this.tui.requestRender();
        return result.handled ? { handled: true, requestRender: true } : { render: true };
      }
      view.offset = previous;
    }
    if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true, requestRender: true }; }
  }

  private renderTabs(width: number, x: number, y: number): string {
    if (width !== this.tabWidth) { this.tabWidth = width; this.revealSelected = true; }
    if (width <= 0) return "";
    const agents = [...this.agents.values()];
    const selected = agents.findIndex(agent => agent.id === this.agentId);
    const labels = agents.map(agent => {
      const name = clean(agent.name).replace(/\s+/g, " ").trim() || agent.id;
      return agent.id === this.agentId ? `[${name}]` : name;
    });
    const layout = (start: number) => {
      const entries: Array<{ id: string; label: string }> = [];
      const prefix = start > 0 ? 4 : 0;
      const remaining = labels.slice(start).reduce((sum, label, i) => sum + visibleWidth(label) + (i ? 2 : 0), 0);
      const space = Math.max(1, width - prefix - (remaining > width - prefix ? 4 : 0));
      let used = 0, end = start;
      for (let i = start; i < agents.length; i++) {
        const gap = i > start ? 2 : 0;
        const label = i === start ? truncateToWidth(labels[i], space, "…") : labels[i];
        if (used + gap + visibleWidth(label) > space) break;
        entries.push({ id: agents[i].id, label });
        used += gap + visibleWidth(label); end = i + 1;
      }
      return { entries, end };
    };
    // At very narrow widths prioritize the selected label; keyboard switching remains available.
    if (width < 11) {
      const label = truncateToWidth(labels[selected], width, "…");
      return this.theme.fg("accent", label);
    }
    this.tabStart = Math.min(this.tabStart, agents.length - 1);
    let page = layout(this.tabStart);
    if (this.revealSelected && (selected < this.tabStart || selected >= page.end)) {
      this.tabStart = selected;
      page = layout(this.tabStart);
    }
    this.revealSelected = false;
    let text = "", column = x;
    const append = (label: string, activate?: () => void) => {
      if (activate) this.targets.push({ x: column, y, width: visibleWidth(label), activate });
      text += label; column += visibleWidth(label);
    };
    if (this.tabStart > 0) {
      append(this.theme.fg("muted", "[<]"), () => {
        // Variable-width labels make the preceding page a different size.
        let previous = this.tabStart - 1;
        while (previous > 0 && layout(previous - 1).end >= this.tabStart) previous--;
        this.tabStart = previous;
        this.tui.requestRender();
      });
      append(" ");
    }
    for (const [index, entry] of page.entries.entries()) {
      if (index) append("  ");
      append(this.theme.fg(entry.id === this.agentId ? "accent" : "muted", entry.label), () => this.selectAgent(entry.id));
    }
    if (page.end < agents.length) {
      append(" ");
      append(this.theme.fg("muted", "[>]"), () => { this.tabStart = page.end; this.tui.requestRender(); });
    }
    return text;
  }

  private renderHeader(width: number): string {
    const bordered = width >= 5, y = bordered ? 1 : 0;
    const border = (text: string) => this.theme.fg("border", text);
    const area = bordered ? width - 5 : Math.max(0, width - 3);
    const padding = area > 0 && bordered ? 1 : 0;
    const tabsWidth = Math.max(0, area - padding - 1);
    const tabs = this.renderTabs(tabsWidth, bordered ? 1 + padding : 0, y);
    const close = width >= 3 ? this.theme.fg("accent", "[X]") : truncateToWidth("[X]", width, "");
    if (width >= 3) this.targets.push({ x: width - (bordered ? 4 : 3), y, width: 3, activate: () => this.close() });
    const title = `${" ".repeat(padding)}${tabs}${" ".repeat(Math.max(0, area - padding - visibleWidth(tabs)))}${close}`;
    return bordered ? `${border("│")}${title}${border("│")}` : title;
  }

  render(width: number): string[] {
    this.targets = []; this.renderedHeight = 0; this.scrollbar = undefined;
    if (width <= 0 || !this.syncAgents()) { this.scrollbarGrab = undefined; return []; }
    const view = this.view;
    const agent = view.snapshot?.agent, model = agent?.resolved_model;
    const modelPrefix = model ? `${model.provider}/${model.id}${agent?.thinking ? ` ${agent.thinking}` : ""} · ` : "";
    const content = [this.theme.fg("muted", clean(`${modelPrefix}${agent?.cwd ?? ""}`))];
    const notice = view.error || clean(view.snapshot?.run?.error ?? "") || (view.truncated ? "Some history omitted" : "");
    if (notice) content.push(this.theme.fg(view.error || view.snapshot?.run?.error ? "error" : "dim", notice));
    const bodyStart = content.length, frameRows = width < 5 ? 1 : 2;
    const inner = Math.max(1, width - 4);
    this.innerWidth = inner; this.bodyTop = frameRows + bodyStart; this.bodyPadding = width < 5 ? 0 : 2;
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    this.pageSize = Math.max(1, height - this.bodyTop - frameRows);
    if (inner !== view.cachedWidth) {
      view.lines = []; view.layout = [];
      for (const entry of view.content.entries) {
        const lines = entry.component.render(inner);
        view.layout.push({ component: entry.component, y: view.lines.length, height: lines.length });
        view.lines.push(...lines, "");
      }
      if (!view.lines.length) view.lines.push("Waiting for completed messages…");
      view.cachedWidth = inner;
    }
    view.maxOffset = Math.max(0, view.lines.length - this.pageSize);
    const offset = Math.min(view.offset, view.maxOffset);
    view.renderedOffset = offset;
    if (width >= 5 && view.maxOffset > 0) {
      const height = Math.max(Math.min(2, this.pageSize), Math.round(this.pageSize ** 2 / view.lines.length));
      this.scrollbar = { height, top: Math.round((this.pageSize - height) * offset / view.maxOffset) };
    } else this.scrollbarGrab = undefined;
    const toolsKey = this.keys.getKeys("app.tools.expand").join("/");
    const thoughtsKey = this.keys.getKeys("app.thinking.toggle").join("/");
    const body = view.lines.slice(offset, offset + this.pageSize);
    while (body.length < this.pageSize) body.push("");
    content.push(...body,
      this.theme.fg("muted", `Click tools/thoughts · ${toolsKey} tools · ${thoughtsKey} thoughts · ↑/↓ scroll · ←/→ tabs · Esc close`),
    );
    const header = this.renderHeader(width);
    const border = (text: string) => this.theme.fg("border", text);
    const rows = width < 5
      ? [header, ...content.map(line => truncateToWidth(line.replace(/\n/g, " "), width, "…"))].slice(0, height)
      : [
        border(`╭${"─".repeat(width - 2)}╮`), header,
        ...content.map((line, index) => {
          const text = truncateToWidth(line.replace(/\n/g, " "), inner, "…");
          const thumb = this.scrollbar, bodyY = index - bodyStart;
          const edge = thumb && bodyY >= thumb.top && bodyY < thumb.top + thumb.height
            ? this.theme.fg("accent", "┃") : border("│");
          return `${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${edge}`;
        }),
        border(`╰${"─".repeat(width - 2)}╯`),
      ].slice(0, height);
    this.renderedHeight = rows.length;
    this.targets = this.targets.filter(target => target.y < rows.length);
    return rows;
  }

  invalidate() {
    for (const view of this.views.values()) view.cachedWidth = -1;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.readAbort.abort();
    for (const view of this.views.values()) disposeView(view);
    this.views.clear(); this.agents.clear(); this.targets = []; this.renderedHeight = 0;
    this.scrollbar = undefined; this.scrollbarGrab = undefined;
    this.abort.signal.removeEventListener("abort", this.onAbort);
    this.abort.abort();
  }
}
