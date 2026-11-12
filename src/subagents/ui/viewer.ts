import type { SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type ScrollView,
  getCapabilities,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { AppearanceConfig } from "../../appearance/config.ts";
import { ViewerContent, cleanViewerText as clean, type ViewerMessage } from "./viewer-content.ts";
import { activeAgents } from "./widget.ts";
import { createEmbeddedViewport, EmbeddedView } from "../../appearance/transcript/embedded-view.ts";
import type { EmbeddedPresentation } from "../../appearance/transcript/embedded.ts";
import type { ToolPresentation } from "../../presentation/tool-source.mjs";
import {
  backgroundAnsi, CODEMODE_ORANGE, DARK_SURFACE_BG, FG_DEFAULT, foregroundAnsi, resolveColorContext,
} from "../../presentation/palette.ts";
import { paintSurfaceBackground } from "../../presentation/sgr.ts";

export interface AgentInspection {
  agent: {
    name?: string;
    state: string;
    cwd?: string;
    resolved_model?: { provider: string; id: string };
    thinking?: string;
    access?: "read" | "write";
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
interface ViewerOptions {
  agentId: string;
  theme: Theme;
  tui: TUI;
  keys: KeybindingsManager;
  done(value: undefined): void;
  abort: AbortController;
  inspect(agentId: string, after: number, signal: AbortSignal): Promise<AgentInspection>;
  appearance: AppearanceConfig;
  agentSource(): ViewerAgent[];
  live: boolean;
  settings: SettingsManager;
  presentation?: EmbeddedPresentation;
}
interface AgentView {
  content: ViewerContent;
  snapshot?: Pick<AgentInspection, "agent" | "run">;
  file: string;
  cursor: number;
  truncated: boolean;
  error: string;
  viewport: ScrollView;
  root: Component;
}
interface HeaderTarget { x: number; y: number; width: number; activate: () => void }
const MAX_CACHED_VIEWS = 8;

function disposeView(view: AgentView) {
  view.content.dispose(); view.viewport.setScrollbar("hidden"); view.snapshot = undefined;
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
  private bodyTop = 2;
  private bodyPadding = 2;
  private innerWidth = 1;
  private renderedHeight = 0;
  private readonly embedded: EmbeddedView;
  private targets: HeaderTarget[] = [];
  private tabStart = 0;
  private tabWidth = -1;
  private revealSelected = true;
  private readonly onAbort: () => void;
  private readonly options: ViewerOptions;
  private readonly rail: string;
  private readonly background: string;

  constructor(options: ViewerOptions) {
    const { agentId, tui, abort, settings } = options;
    this.options = { ...options };
    this.agentId = agentId;
    const colorLevel = resolveColorContext({ terminalTrueColor: getCapabilities().trueColor });
    const orange = foregroundAnsi(CODEMODE_ORANGE, colorLevel);
    this.rail = orange ? `${orange}▏${FG_DEFAULT}` : "▏";
    this.background = backgroundAnsi(DARK_SURFACE_BG, colorLevel);
    this.embedded = new EmbeddedView(tui, settings);
    this.cacheView(agentId);
    this.onAbort = () => this.close();
    abort.signal.addEventListener("abort", this.onAbort, { once: true });
    if (abort.signal.aborted) this.onAbort();
    else void this.refresh(this.view, this.readAbort);
  }

  private syncAgents(): boolean {
    if (this.disposed) return false;
    const source = this.options.agentSource();
    const visible = new Map((this.options.live ? activeAgents(source) : source).map(agent => [agent.id, agent]));
    const changed = visible.size !== this.agents.size || [...visible.keys()].some(id => !this.agents.has(id));
    this.agents = visible;
    for (const [id, view] of this.views) {
      if (!visible.has(id)) { disposeView(view); this.views.delete(id); }
    }
    if (!visible.size) { this.close(); return false; }
    if (changed) {
      this.targets = []; this.renderedHeight = 0; this.revealSelected = true;
      this.options.tui.requestRender();
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
      const content = new ViewerContent(this.embedded.tui, this.options.appearance, this.options.settings);
      const viewport = createEmbeddedViewport({
        document: content.document,
        footer: { render: width => [truncateToWidth(this.footer(), width, "…")], invalidate() {} },
      });
      view = { content, root: viewport.root, viewport: viewport.transcript, file: "", cursor: 0, truncated: false, error: "" };
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
    this.embedded.clearInteraction();
    this.options.tui.requestRender();
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
      const snapshot = await this.options.inspect(this.agentId, view.cursor, controller.signal);
      if (!current() || !this.syncAgents() || !current()) return;
      if (snapshot.reset || (view.file && view.file !== snapshot.session_file)) {
        view.content.dispose(); view.viewport.scrollToEnd(); view.truncated = false;
        view.cursor = 0; view.file = snapshot.session_file; more = true; return;
      }
      view.file = snapshot.session_file;
      view.snapshot = { agent: snapshot.agent, run: snapshot.run };
      view.cursor = snapshot.next_cursor; more = snapshot.has_more;
      if (snapshot.agent.name) this.agents.set(this.agentId, { ...this.agents.get(this.agentId)!, name: snapshot.agent.name });
      if (snapshot.history_pruned) view.truncated = true;
      view.content.setToolRenderers(snapshot.tool_renderers ?? {});
      for (const entry of snapshot.messages) view.content.append(entry.message, snapshot.agent.cwd ?? "");
      view.content.refresh();
      view.truncated ||= view.content.truncated;
      view.error = "";
      this.embedded.tui.requestRender();
    } catch (error) {
      if (!current()) return;
      view.error = clean(String(error));
    } finally {
      if (current()) {
        this.options.tui.requestRender();
        if (more || this.options.live) this.timer = setTimeout(() => void this.refresh(view, controller), more ? 50 : 1000);
      }
    }
  }

  private close() {
    if (this.disposed) return;
    this.dispose();
    this.options.done(undefined);
  }

  private scroll(delta: number) {
    this.view.viewport.scrollBy(delta);
    this.options.tui.requestRender();
  }

  handleInput(data: string) {
    if (!this.syncAgents()) return;
    if (this.options.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c") || data === "q") this.close();
    else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.cycleAgent(-1);
    else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.cycleAgent(1);
    else if (this.options.keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (this.options.keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
    else if (matchesKey(data, "home")) { this.view.viewport.scrollToStart(); this.options.tui.requestRender(); }
    else if (matchesKey(data, "end")) { this.view.viewport.scrollToEnd(); this.options.tui.requestRender(); }
    else if (this.options.keys.matches(data, "app.tools.expand") || this.options.keys.matches(data, "app.thinking.toggle")) {
      this.view.viewport.scrollTo(this.view.viewport.scrollTop, { disableFollow: true });
      if (this.options.keys.matches(data, "app.tools.expand")) this.view.content.toggleTools();
      else this.view.content.toggleThinking();
      this.invalidate(); this.options.tui.requestRender();
    } else this.embedded.input(data);
  }

  handleMouse(event: TuiMouseEvent) {
    if (!this.syncAgents()) return;
    if (this.embedded.hasPointerCapture && (event.type === "drag" || event.type === "release")) {
      this.forwardMouse(event);
      return { handled: true };
    }
    if (event.y < 0 || event.y >= this.renderedHeight) return;
    const target = this.targets.find(target => event.y === target.y && event.x >= target.x && event.x < target.x + target.width);
    if (target && event.button === "left") {
      if (event.type === "click") { target.activate(); return { handled: true, requestRender: true }; }
      if (event.type === "press" || event.type === "release") return { handled: true };
    }
    const inBody = event.y >= this.bodyTop && event.y < this.bodyTop + this.pageSize
      && event.x >= this.bodyPadding && event.x < this.bodyPadding + this.innerWidth;
    if (inBody || event.type === "wheel") {
      this.forwardMouse(event);
      return { handled: true, capture: event.type === "press", requestRender: true };
    }
  }

  private forwardMouse(event: TuiMouseEvent): void {
    this.embedded.handleMouse({ ...event, x: event.x - this.bodyPadding, y: event.y - this.bodyTop,
      width: this.innerWidth, height: this.pageSize });
    this.options.tui.requestRender();
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
      return this.options.theme.fg("accent", label);
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
      append(this.options.theme.fg("muted", "[<]"), () => {
        // Variable-width labels make the preceding page a different size.
        let previous = this.tabStart - 1;
        while (previous > 0 && layout(previous - 1).end >= this.tabStart) previous--;
        this.tabStart = previous;
        this.options.tui.requestRender();
      });
      append(" ");
    }
    for (const [index, entry] of page.entries.entries()) {
      if (index) append("  ");
      append(this.options.theme.fg(entry.id === this.agentId ? "accent" : "muted", entry.label), () => this.selectAgent(entry.id));
    }
    if (page.end < agents.length) {
      append(" ");
      append(this.options.theme.fg("muted", "[>]"), () => { this.tabStart = page.end; this.options.tui.requestRender(); });
    }
    return text;
  }

  private renderHeader(width: number): string {
    const hasRail = width >= 5;
    const area = hasRail ? width - 5 : Math.max(0, width - 3);
    const padding = area > 0 && hasRail ? 1 : 0;
    const tabsWidth = Math.max(0, area - padding - 1);
    const tabs = this.renderTabs(tabsWidth, hasRail ? 1 + padding : 0, 0);
    const close = width >= 3 ? this.options.theme.fg("accent", "[X]") : truncateToWidth("[X]", width, "");
    if (width >= 3) this.targets.push({ x: width - (hasRail ? 4 : 3), y: 0, width: 3, activate: () => this.close() });
    const title = `${" ".repeat(padding)}${tabs}${" ".repeat(Math.max(0, area - padding - visibleWidth(tabs)))}${close}`;
    return hasRail ? `${this.rail}${title} ` : title;
  }

  private footer(): string {
    const tools = this.options.keys.getKeys("app.tools.expand").join("/");
    const thinking = this.options.keys.getKeys("app.thinking.toggle").join("/");
    return this.options.theme.fg("muted",
      `Click tools/thoughts · ${tools} tools · ${thinking} thoughts · ↑/↓ scroll · ←/→ tabs · Esc close`);
  }

  render(width: number): string[] {
    this.targets = []; this.renderedHeight = 0;
    if (width <= 0 || !this.syncAgents()) {
      this.embedded.clearInteraction(); return [];
    }
    const view = this.view, agent = view.snapshot?.agent, model = agent?.resolved_model;
    const inner = width < 5 ? width : width - 4;
    const modelLabel = model ? `${model.provider}/${model.id}${agent?.thinking ? ` ${agent.thinking}` : ""}` : "";
    const metadata = clean([modelLabel, agent?.access, agent?.cwd].filter(Boolean).join(" · "));
    const status = wrapTextWithAnsi(metadata, inner).map(line => this.options.theme.fg("muted", line));
    const notice = view.error || clean(view.snapshot?.run?.error ?? "") || (view.truncated ? "Some history omitted" : "");
    if (notice) status.push(this.options.theme.fg(view.error || view.snapshot?.run?.error ? "error" : "dim", notice));
    const height = Math.max(1, Math.floor(this.options.tui.terminal.rows * 0.7));
    this.bodyTop = 1 + status.length; this.bodyPadding = width < 5 ? 0 : 2;
    this.innerWidth = width < 5 ? width : width - 3;
    this.pageSize = Math.max(1, height - this.bodyTop - 1);
    this.embedded.setRoot(view.root, this.options.presentation);
    const body = this.embedded.render(this.innerWidth, this.pageSize + 1);
    const rows = [this.renderHeader(width), ...[...status, ...body].map(line => {
      const text = line.replace(/\n/g, " ");
      if (width < 5) return truncateToWidth(text, width, "…");
      return `${this.rail} ${truncateToWidth(text, this.innerWidth, "…")} `;
    })].slice(0, height);
    this.renderedHeight = rows.length;
    this.targets = this.targets.filter(target => target.y < rows.length);
    return rows.map(row => paintSurfaceBackground(
      row + " ".repeat(Math.max(0, width - visibleWidth(row))), this.background,
    ));
  }

  invalidate() { this.embedded.tui.invalidate(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.readAbort.abort();
    for (const view of this.views.values()) disposeView(view);
    this.views.clear(); this.agents.clear(); this.targets = []; this.renderedHeight = 0;
    this.embedded.dispose();
    this.options.abort.signal.removeEventListener("abort", this.onAbort);
    this.options.abort.abort();
  }
}
