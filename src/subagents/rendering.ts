import { Container, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { auxiliaryToolRenderers, displayRecord, inlineToolText } from "../execution/ui/auxiliary-tool.ts";

const titles: Record<string, [string, string]> = {
  pi_spawn_agent: ["Starting subagent", "Started subagent"],
  pi_wait_agent: ["Waiting for subagents", "Waited for subagents"],
  pi_list_agents: ["Listing subagents", "Listed subagents"],
  pi_inspect_agent: ["Inspecting subagent", "Inspected subagent"],
  pi_agent_result: ["Reading subagent result", "Read subagent result"],
  pi_ack_result: ["Acknowledging subagent result", "Acknowledged subagent result"],
  pi_answer_agent: ["Answering subagent", "Answered subagent"],
  pi_send_message: ["Messaging subagent", "Messaged subagent"],
  pi_followup_task: ["Assigning subagent task", "Assigned subagent task"],
  pi_interrupt_agent: ["Interrupting subagent", "Interrupted subagent"],
};

function payload(result?: AgentToolResult<unknown>): Record<string, unknown> {
  if (result?.structuredContent) return displayRecord(result.structuredContent);
  // Pi's row forwards content/details, so replayed rows also read the original JSON text.
  const text = result?.content.find(block => block.type === "text");
  try { return displayRecord(text?.type === "text" ? JSON.parse(text.text) : undefined); }
  catch { return {}; }
}

function summary(name: string, data: Record<string, unknown>): string {
  if (name === "pi_list_agents") return `${data.total ?? (Array.isArray(data.agents) ? data.agents.length : 0)} subagents`;
  if (name === "pi_wait_agent") {
    const runs = Array.isArray(data.runs) ? data.runs.map(displayRecord) : [];
    const states = runs.map(run => `${run.name ?? run.id ?? "run"}: ${run.state ?? "returned"}`);
    return states.join("; ") || String(data.reason ?? "No runs returned");
  }
  if (name === "pi_inspect_agent" || name === "pi_agent_result") {
    const agent = displayRecord(data.agent), run = displayRecord(data.run);
    return `${agent.name ?? run.name ?? agent.id ?? run.id ?? "Subagent"} · ${agent.state ?? run.state ?? "result available"}`;
  }
  if (name === "pi_ack_result") return data.acknowledged ? "Result acknowledged" : "Result not acknowledged";
  if (name === "pi_answer_agent") return data.sent ? "Answer sent" : "Answer not sent";
  if (name === "pi_interrupt_agent") return `Previous state: ${data.previous_status ?? "unknown"}${data.forced ? " · forced" : ""}`;
  return [data.name ?? data.agent_id, data.state ?? data.delivery ?? "Accepted"].filter(Boolean).join(" · ");
}

export function subagentToolRenderers(name: string): Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell"> {
  const [active, complete] = titles[name] ?? [name, name];
  const base = auxiliaryToolRenderers(`${active} failed`, (args, result) => {
    const data = payload(result);
    const target = args.name ?? args.agent_id ?? args.run_id
      ?? (Array.isArray(args.run_ids) ? `${args.run_ids.length} run(s)` : undefined);
    const questions = Array.isArray(data.questions) ? data.questions.length : 0;
    const failed = Array.isArray(data.runs) ? data.runs.filter(run => displayRecord(run).state === "failed").length : 0;
    return { active, complete, target: typeof target === "string" ? target : undefined,
      ...(result ? { summary: inlineToolText(summary(name, data)), warning: [data.timed_out ? "Wait timed out" : "",
        failed ? `${failed} subagent(s) failed` : "",
        questions ? `${questions} question(s) awaiting an answer` : ""].filter(Boolean).join(" · ") || undefined } : {}),
    };
  });
  return {
    ...base, renderShell: "self",
    renderCall(args, theme, context) {
      const head = base.renderCall!(args, theme, context);
      if (!context.expanded) return head;
      const box = new Container();
      box.addChild(head);
      box.addChild(new Text(theme.fg("dim", JSON.stringify(args, null, 2) ?? ""), 2, 0));
      return box;
    },
  };
}
