import { Container, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { auxiliaryToolRenderers, displayRecord, inlineToolText } from "../../execution/ui/auxiliary-tool.ts";

const titles: Record<string, [string, string]> = {
  subagents_spawn_agent: ["Starting subagent", "Started subagent"],
  subagents_wait_agent: ["Waiting for subagents", "Waited for subagents"],
  subagents_list_agents: ["Listing subagents", "Listed subagents"],
  subagents_inspect_agent: ["Inspecting subagent", "Inspected subagent"],
  subagents_agent_result: ["Reading subagent result", "Read subagent result"],
  subagents_answer_agent: ["Answering subagent", "Answered subagent"],
  subagents_send_message: ["Messaging subagent", "Messaged subagent"],
  subagents_followup_task: ["Assigning subagent task", "Assigned subagent task"],
  subagents_interrupt_agent: ["Interrupting subagent", "Interrupted subagent"],
};

function payload(result?: AgentToolResult<unknown>): Record<string, unknown> {
  if (result?.structuredContent) return displayRecord(result.structuredContent);
  // Pi's row forwards content/details, so replayed rows also read the original JSON text.
  const text = result?.content.find(block => block.type === "text");
  try { return displayRecord(text?.type === "text" ? JSON.parse(text.text) : undefined); }
  catch { return {}; }
}

function summary(name: string, data: Record<string, unknown>): string {
  if (name === "subagents_list_agents") {
    const returned = Array.isArray(data.agents) ? data.agents.length : 0;
    const total = data.total ?? returned;
    return (
      `${returned}` +
      " returned" +
      `${data.matched !== undefined && data.matched !== total ? ` · ${data.matched} matches` : ""}` +
      " · " +
      `${total}` +
      " total subagents"
    );
  }
  if (name === "subagents_wait_agent") {
    const runs = Array.isArray(data.runs) ? data.runs.map(displayRecord) : [];
    const states = runs.map((run) => `${run.name ?? run.id ?? "run"}: ${run.state ?? "returned"}`);
    return states.join("; ") || String(data.reason ?? "No runs returned");
  }
  if (name === "subagents_inspect_agent" || name === "subagents_agent_result") {
    const agent = displayRecord(data.agent),
      run = displayRecord(data.run);
    return `${agent.name ?? run.name ?? agent.id ?? run.id ?? "Subagent"} · ${agent.state ?? run.state ?? "result available"}`;
  }
  if (name === "subagents_answer_agent") return data.sent ? "Answer sent" : "Answer not sent";
  if (name === "subagents_interrupt_agent")
    return `Previous state: ${data.previous_status ?? "unknown"}${data.forced ? " · forced" : ""}`;
  return [data.name ?? data.agent_id, data.state ?? data.delivery ?? "Accepted"].filter(Boolean).join(" · ");
}

export const isSubagentTool = (name: string): boolean => Object.hasOwn(titles, name.replace(/^pi_/, "subagents_"));

export function subagentToolRenderers(
  name: string,
): Required<Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">> {
  // Read pre-rename transcripts without registering callable aliases.
  const canonical = name.replace(/^pi_/, "subagents_");
  const [active, complete] = titles[canonical] ?? [name, name];
  const base = auxiliaryToolRenderers(`${active} failed`, (args, result) => {
    const data = payload(result);
    const target =
      args.name ??
      args.agent_id ??
      args.run_id ??
      (canonical === "subagents_list_agents" ? args.query : undefined) ??
      (Array.isArray(args.agent_ids)
        ? args.agent_ids.join(", ")
        : Array.isArray(args.run_ids)
          ? `${args.run_ids.length} run(s)`
          : undefined);
    const questions = Array.isArray(data.questions) ? data.questions.length : 0;
    const failed = Array.isArray(data.runs)
      ? data.runs.filter((run) => displayRecord(run).state === "failed").length
      : 0;
    return {
      active,
      complete,
      target: typeof target === "string" ? target : undefined,
      ...(result
        ? {
            summary: inlineToolText(summary(canonical, data)),
            warning:
              [
                data.timed_out ? "Wait timed out" : "",
                failed ? `${failed} subagent(s) failed` : "",
                questions ? `${questions} question(s) awaiting an answer` : "",
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
          }
        : {}),
    };
  });
  return {
    ...base,
    renderShell: "self",
    renderCall(args, theme, context) {
      const head = base.renderCall(args, theme, context);
      if (!context.expanded) return head;
      const box = new Container();
      box.addChild(head);
      box.addChild(new Text(theme.fg("dim", JSON.stringify(args, null, 2) ?? ""), 2, 0));
      return box;
    },
  };
}

export const subagentAttentionRenderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] = (message, { expanded }, theme) => {
  const text = typeof message.content === "string" ? message.content : "";
  let status: string;
  try { status = summary("subagents_wait_agent", JSON.parse(text.slice(text.indexOf("\n") + 1))); }
  catch { status = text.split("\n").slice(1, 5).join("; ") || "Attention"; }
  const header = theme.fg("accent", "Subagents") + " · " + inlineToolText(status);
  return new Text(header + (expanded ? "\n" + text : "\n" + theme.fg("dim", "ctrl+o to expand")), 0, 0);
};
