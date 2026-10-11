import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth } from "@earendil-works/pi-tui";

export interface WidgetAgent {
  id: string; name: string; state: string; started?: number;
  active_tools?: string[]; tool_uses?: number; total_tokens?: number; response_preview?: string;
}

export const cleanLabel = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const ACTIVE = new Set(["starting", "running", "needs_input", "stopping"]);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACTIONS: Record<string, string> = {
  read: "reading", bash: "running command", exec_command: "running command", write_stdin: "waiting for command",
  edit: "editing", write: "writing", apply_patch: "applying patch", grep: "searching", find: "finding files", ls: "listing",
};

export const activeAgents = (agents: WidgetAgent[]) => agents.filter(agent => ACTIVE.has(agent.state));

/** Live rows and their mouse targets come from the same rendered snapshot. */
export function subagentWidget(theme: Theme, agents: () => WidgetAgent[], open: (id: string) => void) {
  let targets: Array<string | undefined> = [];
  return new MouseRegion({
    render(width) {
      targets = [];
      if (width <= 0) return [];
      const active = activeAgents(agents()).sort((a, b) => Number(b.state === "needs_input") - Number(a.state === "needs_input"));
      if (!active.length) return [];
      const shown = active.slice(0, 5), overflow = active.length - shown.length;
      const now = Date.now(), frame = SPINNER[Math.floor(now / 250) % SPINNER.length];
      const lines = [theme.fg("accent", `● Subagents · ${active.length} active`)];
      targets.push(undefined);
      for (const [index, agent] of shown.entries()) {
        const waiting = agent.state === "needs_input", tone = waiting ? "warning" : "accent";
        const last = index === shown.length - 1 && !overflow;
        const state = waiting ? "waiting for input" : agent.state;
        const stats: string[] = [];
        if (agent.tool_uses) stats.push(`${agent.tool_uses} tool use${agent.tool_uses === 1 ? "" : "s"}`);
        if (agent.total_tokens)
          stats.push(
            `${agent.total_tokens >= 1000 ? `${(agent.total_tokens / 1000).toFixed(1)}k` : agent.total_tokens} tokens`,
          );
        if (agent.started) {
          const seconds = Math.max(0, Math.floor(now / 1000 - agent.started));
          stats.push(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
        }
        const tools = [...new Set((agent.active_tools ?? []).filter(tool => typeof tool === "string"))];
        const activity = waiting ? "waiting for input" : tools.length ? tools.map(tool => ACTIONS[tool] ?? cleanLabel(tool)).join(", ") + "…"
          : agent.state === "running" ? cleanLabel(agent.response_preview ?? "") || "thinking…" : state;
        const icon = waiting ? "?" : agent.state === "running" ? frame : "◦";
        lines.push(theme.fg("dim", last ? "└─ " : "├─ ") + theme.fg(tone, `${icon} ${theme.bold(cleanLabel(agent.name))}`)
          + theme.fg("muted", ` · ${state}${stats.length ? ` · ${stats.join(" · ")}` : ""}`));
        lines.push(theme.fg("dim", `${last ? "   " : "│  "}  ⎿  `) + theme.fg(waiting ? "warning" : "muted", activity));
        targets.push(agent.id, agent.id);
      }
      if (overflow) { lines.push(theme.fg("dim", `└─ +${overflow} more active`)); targets.push(undefined); }
      return lines.map(line => truncateToWidth(line, width, "…"));
    },
    invalidate() {},
  }, event => {
    if (event.type !== "click" || event.button !== "left") return;
    const id = targets[event.y];
    if (!id) return;
    open(id);
    return { handled: true };
  });
}
