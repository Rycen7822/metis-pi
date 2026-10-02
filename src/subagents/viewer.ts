import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface AgentInspection {
  agent: { name?: string; state: string; cwd?: string; resolved_model?: { provider: string; id: string }; active_tools?: string[] };
  events: Array<{ type: string; data: Record<string, unknown> }>;
  next_cursor: number;
  has_more: boolean;
  history_pruned?: boolean;
  run?: { state: string };
}

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
const describe = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? "";

function eventText(event: AgentInspection["events"][number]): string {
  const data = event.data;
  if (data.truncated) return `${event.type} (preview):\n${data.preview ?? "Event exceeded the preview limit"}`;
  if (event.type === "message") return `${data.role}:\n${data.text || "(no text content)"}`;
  if (event.type === "tool_execution_start") return `Tool: ${data.toolName}\n${describe(data.args)}`;
  if (event.type === "tool_execution_end") {
    const result = data.result as { content?: Array<{ type: string; text?: string }> } | undefined;
    const output = result?.content?.map(block => block.type === "text" ? block.text : `[${block.type}]`).join("\n") ?? "";
    return `Tool ${data.isError ? "error" : "result"}: ${data.toolName}\n${output}`;
  }
  if (event.type === "needs_input") return `Waiting for input:\n${data.title ?? data.message ?? describe(data)}`;
  if (["start_failed", "protocol_error", "input_rejected"].includes(event.type)) return `${event.type}:\n${describe(data)}`;
  return "";
}

/** Read-only, bounded event view. Opening it never consumes attention or ACKs a result. */
export class SubagentViewer implements Component {
  private snapshot?: AgentInspection;
  private history = "";
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
  ) {
    this.agentId = agentId; this.theme = theme; this.tui = tui; this.keys = keys;
    this.done = done; this.abort = abort; this.inspect = inspect;
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
      this.snapshot = snapshot; this.cursor = snapshot.next_cursor; more = snapshot.has_more;
      if (snapshot.history_pruned) this.truncated = true;
      const text = snapshot.events.map(eventText).filter(Boolean).join("\n\n");
      if (text) this.history += `${clean(text)}\n\n`;
      if (this.history.length > 32_000) {
        this.history = this.history.slice(-32_000).replace(/^[^\n]*\n/, ""); this.truncated = true;
      }
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
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c") || data === "q") this.done(undefined);
    else if (this.keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
    else if (matchesKey(data, "home")) { this.offset = 0; this.tui.requestRender(); }
    else if (matchesKey(data, "end")) { this.offset = Infinity; this.tui.requestRender(); }
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "wheel") return;
    this.scroll(event.wheelDelta ?? 0);
    return { handled: true, requestRender: true };
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const inner = Math.max(1, width - 4);
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7));
    this.pageSize = Math.max(1, height - 7);
    if (inner !== this.cachedWidth) {
      this.lines = wrapTextWithAnsi(this.history.trimEnd() || "Waiting for completed messages…", inner);
      this.cachedWidth = inner;
    }
    this.maxOffset = Math.max(0, this.lines.length - this.pageSize);
    const offset = Math.min(this.offset, this.maxOffset);
    const agent = this.snapshot?.agent;
    const model = agent?.resolved_model;
    const body = this.lines.slice(offset, offset + this.pageSize);
    while (body.length < this.pageSize) body.push("");
    const content = [
      this.theme.fg("accent", `Subagent: ${clean(agent?.name ?? this.agentId)}`),
      clean(`${agent?.state ?? "loading"} · run ${this.snapshot?.run?.state ?? "—"}${agent?.active_tools?.length ? ` · tools: ${agent.active_tools.join(", ")}` : ""}`),
      this.theme.fg("muted", clean(`${model ? `${model.provider}/${model.id} · ` : ""}${agent?.cwd ?? ""}`)),
      this.theme.fg("dim", this.error || (this.truncated ? "Earlier history omitted" : "Completed messages and tool activity")),
      ...body,
      this.theme.fg("muted", "↑/↓ · wheel scroll · Home/End · Esc close"),
    ];
    if (width < 5) return content.slice(0, height).map(line => truncateToWidth(line.replace(/\n/g, " "), width, "…"));
    const border = (text: string) => this.theme.fg("border", text);
    return [border(`╭${"─".repeat(width - 2)}╮`), ...content.map(line => {
      const text = truncateToWidth(line.replace(/\n/g, " "), inner, "…");
      return `${border("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border("│")}`;
    }), border(`╰${"─".repeat(width - 2)}╯`)].slice(0, height);
  }

  invalidate() { this.cachedWidth = -1; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer);
    this.abort.signal.removeEventListener("abort", this.onAbort); this.abort.abort();
  }
}
