import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { MouseRegion, truncateToWidth } from "@earendil-works/pi-tui";
import { hasTrustRequiringProjectResources, ProjectTrustStore, type AgentBeforeSettleEvent, type ExtensionAPI, type ExtensionContext, type ToolDefinition, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { SubagentClient, type RuntimePackage } from "./client.ts";
import { SubagentViewer, type AgentInspection } from "./viewer.ts";

const BINDING = "metis-subagent-scope", RECEIPT = "metis-subagent-receipt", ATTENTION = "metis-subagent-attention";
interface Ticket { id: string; events: string[]; receipts: string[] }
interface Attention { notification_id: string; run_id: string; agent_id: string; name: string; event: string; state: string; ui_request_id?: string }
interface Delivery { ticket: Ticket; successful: boolean; parent?: string }
interface ReceiptProof extends Ticket { sessionId: string; scope: string; digest: string }
const digest = (content: unknown) => createHash("sha256").update(JSON.stringify(content)).digest("hex");
const cleanName = (name: string) => stripVTControlCharacters(name).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

/** Owns one frontend lease. The daemon remains the sole owner of agents and runs. */
export class SubagentSession {
  private readonly pi: ExtensionAPI;
  private readonly agentDir: string;
  private readonly client: SubagentClient;
  private readonly watchAbort = new AbortController();
  private watching?: Promise<void>;
  private closed = false;
  private deliveries = new Map<string, Delivery>();
  private pending: Attention[] = [];
  private agents: Array<{ id: string; name: string; state: string; current_run: string | null; cwd: string }> = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly sessionId: string;
  private ctx: ExtensionContext;
  private widgetText = "";
  private viewerAbort?: AbortController;
  private observed = new Set<string>();

  constructor(pi: ExtensionAPI, runtime: RuntimePackage, ctx: ExtensionContext, agentDir: string) {
    this.pi = pi; this.agentDir = agentDir;
    this.ctx = ctx; this.sessionId = ctx.sessionManager.getSessionId();
    const binding = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === BINDING && (entry.data as { sessionId?: string })?.sessionId === this.sessionId);
    const scope = binding?.type === "custom" ? (binding.data as { scope: string }).scope : undefined;
    this.client = new SubagentClient(runtime, ctx, agentDir, scope, scope => {
      if (!this.closed) pi.appendEntry(BINDING, { sessionId: this.sessionId, scope });
    });
    if (scope) this.startWatching();
  }
  update(ctx: ExtensionContext) { if (ctx.sessionManager.getSessionId() === this.sessionId) { this.ctx = ctx; this.client.update(ctx); } }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn); this.chain = task.catch(() => {}); return task;
  }
  private valid() { return !this.closed && this.ctx.sessionManager.getSessionId() === this.sessionId; }
  private renderWidget() {
    if (this.ctx.mode !== "tui") return;
    const active = this.agents.filter(agent => ["starting", "running", "needs_input", "stopping"].includes(agent.state));
    const rows = active.slice(0, 8).map(agent => ({
      id: agent.id,
      text: `${cleanName(agent.name)} · ${agent.state === "needs_input" ? "waiting for input" : agent.state}`,
      tone: agent.state === "needs_input" ? "warning" as const : "accent" as const,
    }));
    const signature = JSON.stringify([active.length, rows]);
    if (signature === this.widgetText) return;
    this.widgetText = signature;
    this.ctx.ui.setWidget("metis-subagents", active.length ? (_tui, theme) => new MouseRegion({
      render: width => width > 0 ? [
        theme.fg("muted", `Subagents · ${active.length} active`),
        ...rows.map(row => `  ${theme.fg(row.tone, row.text)}`),
        ...(active.length > rows.length ? [theme.fg("muted", `  +${active.length - rows.length} more`)] : []),
      ].map(line => truncateToWidth(line, width, "…")) : [],
      invalidate() {},
    }, event => {
      if (event.type !== "click" || event.button !== "left") return;
      const row = rows[event.y - 1];
      if (!row) return;
      void this.openViewer(row.id);
      return { handled: true };
    }) : undefined, { placement: "aboveEditor" });
  }
  private async openViewer(agentId: string) {
    if (!this.valid() || this.ctx.mode !== "tui" || this.viewerAbort) return;
    const abort = new AbortController(); this.viewerAbort = abort;
    let viewer: SubagentViewer | undefined;
    try {
      await this.ctx.ui.custom<undefined>((tui, theme, keys, done) => viewer = new SubagentViewer(
        agentId, theme, tui, keys, done, abort,
        async after => await this.client.call("pi_inspect_agent", { agent_id: agentId, detail: "full", after, limit: 100, max_bytes: 16384 }, abort.signal) as unknown as AgentInspection,
      ), { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } });
    } catch (error) {
      if (this.valid()) this.ctx.ui.notify(`Subagent view failed: ${String(error)}`, "warning");
    } finally {
      viewer?.dispose(); abort.abort(); if (this.viewerAbort === abort) this.viewerAbort = undefined;
    }
  }
  private async reconcile() {
    if (!this.valid()) return;
    const receipts = new Set<string>();
    for (const entry of this.ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === RECEIPT) {
        const data = entry.data as { sessionId?: string; scope?: string; receipt?: string };
        if (data?.sessionId === this.sessionId && data.scope === this.client.scope && data.receipt) receipts.add(data.receipt);
      }
      if (entry.type === "custom_message" && entry.customType === ATTENTION) {
        const data = entry.details as { sessionId?: string; scope?: string; receipt?: string };
        if (data?.sessionId === this.sessionId && data.scope === this.client.scope && data.receipt) receipts.add(data.receipt);
      }
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
      const message = entry.message;
      const detail = message.details as { metisSubagentReceipt?: ReceiptProof } | undefined;
      const proof = detail?.metisSubagentReceipt;
      if (message.toolName === "pi_wait_agent" && proof?.sessionId === this.sessionId && proof.scope === this.client.scope && proof.digest === digest(message.content)) {
        for (const receipt of proof.receipts) receipts.add(receipt);
      }
      for (const nested of message.nestedCalls?.calls ?? []) {
        const delivery = this.deliveries.get(nested.id);
        if (nested.status === "ok" && delivery?.successful && delivery.parent === message.toolCallId) for (const receipt of delivery.ticket.receipts) receipts.add(receipt);
      }
    }
    for (const receipt of receipts) {
      if (this.observed.has(receipt)) continue;
      await this.client.call("pi_observe", { receipt });
      this.observed.add(receipt);
    }
    const saved = new Set<string>();
    for (const [id, delivery] of this.deliveries) if (delivery.ticket.receipts.every(receipt => this.observed.has(receipt))) {
      for (const receipt of delivery.ticket.receipts) if (!saved.has(receipt)) {
        this.pi.appendEntry(RECEIPT, { sessionId: this.sessionId, scope: this.client.scope, receipt }); saved.add(receipt);
      }
      this.deliveries.delete(id);
    }
  }
  private startWatching() {
    if (this.watching || this.closed) return;
    this.watching = (async () => {
      let cursor: unknown;
      try {
        await this.serialize(() => this.reconcile());
        while (this.valid()) {
          const result = await this.client.call("pi_watch", { ...(cursor ? { after: cursor } : {}) }, this.watchAbort.signal);
          if (!this.valid()) return;
          cursor = result.cursor; this.pending = result.notifications as Attention[]; this.agents = result.agents as typeof this.agents;
          this.renderWidget();
          if (this.ctx.isIdle() && !this.ctx.hasPendingMessages()) await this.serialize(() => this.deliverIdle());
        }
      } catch (error) {
        if (this.valid()) this.ctx.ui.notify(`Subagent watch stopped: ${String(error)}`, "warning");
      }
    })();
  }
  private async claim() {
    await this.reconcile();
    if (!this.valid() || !this.pending.length) return;
    const claim = await this.client.call("pi_claim", { events: this.pending.slice(0, 20).map(event => event.notification_id) });
    const events = claim.events as Attention[];
    if (!events.length) return;
    return { receipt: claim.id as string, events };
  }
  private message(claim: { receipt: string; events: Attention[] }) {
    return { customType: ATTENTION, display: true,
      content: "Subagent attention (status only; inspect results and answer questions explicitly):\n" + claim.events.map(e => `${e.name}: ${e.state}; run ${e.run_id}${e.ui_request_id ? `; question ${e.ui_request_id}` : ""}`).join("\n"),
      details: { sessionId: this.sessionId, scope: this.client.scope, receipt: claim.receipt } };
  }
  private async deliverIdle() {
    if (!this.valid() || !this.ctx.isIdle() || this.ctx.hasPendingMessages()) return;
    const claim = await this.claim(); if (!claim) return;
    if (!this.valid() || !this.ctx.isIdle() || this.ctx.hasPendingMessages()) { await this.client.call("pi_release", { receipt: claim.receipt }); return; }
    try { this.pi.sendMessage(this.message(claim), { triggerTurn: true }); }
    catch (error) { await this.client.call("pi_uncertain", { receipt: claim.receipt }); throw error; }
    await this.reconcile();
  }
  async beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
    this.update(ctx);
    return this.serialize(async () => {
      if (!this.client.scope || !this.valid()) return;
      if (event.outcome !== "completed") { await this.reconcile(); return; }
      const claim = await this.claim(); if (!claim) return;
      if (!this.valid()) { await this.client.call("pi_release", { receipt: claim.receipt }); return; }
      return { entries: [...event.entries, { type: "custom_message" as const, ...this.message(claim) }], continue: true };
    });
  }
  async settled(ctx: ExtensionContext, final = false) {
    this.update(ctx);
    if (!this.client.scope || !this.valid()) return;
    await this.serialize(async () => {
      await this.reconcile();
      if (final) for (const [id, delivery] of this.deliveries) {
        for (const receipt of delivery.ticket.receipts) await this.client.call("pi_uncertain", { receipt });
        this.deliveries.delete(id);
      }
      await this.deliverIdle();
    });
  }
  result(event: ToolResultEvent) {
    const delivery = this.deliveries.get(event.toolCallId);
    if (delivery) { delivery.successful = !event.isError; delivery.parent = event.parentToolCallId; }
    if (delivery && event.isError && !event.parentToolCallId) {
      void Promise.all(delivery.ticket.receipts.map(receipt => this.client.call("pi_release", { receipt }))).then(() => this.deliveries.delete(event.toolCallId)).catch(() => {});
    }
  }
  private async trust(cwd: string) {
    const path = realpathSync(resolve(cwd));
    if (path === realpathSync(this.ctx.cwd)) return { cwd: path, trusted: this.ctx.isProjectTrusted() };
    const stored = new ProjectTrustStore(this.agentDir).get(path);
    if (!hasTrustRequiringProjectResources(path)) return { cwd: path, trusted: true };
    if (stored !== null) return { cwd: path, trusted: stored };
    if (this.pi.getSettings().defaultProjectTrust === "always") return { cwd: path, trusted: true };
    if (this.pi.getSettings().defaultProjectTrust === "never" || !this.ctx.hasUI) return { cwd: path, trusted: false };
    const choice = await this.ctx.ui.select("Subagent project resources", [`Trust resources in ${path} for this parent session`, "Use without project resources"]);
    if (choice === undefined) throw new Error("Subagent launch cancelled; project trust was not granted");
    return { cwd: path, trusted: choice.startsWith("Trust resources") };
  }
  async execute(name: string, args: Record<string, unknown>, id: string, ctx: ExtensionContext, signal?: AbortSignal) {
    this.update(ctx);
    if (!this.valid()) throw new Error("Subagent parent session changed");
    let extra: object | undefined;
    if (name === "pi_spawn_agent") extra = { project_trust: await this.trust((args.cwd as string | undefined) ?? ctx.cwd) };
    if (name === "pi_send_message" || name === "pi_followup_task") {
      const agent = this.agents.find(a => a.id === args.agent_id || a.name === args.agent_id);
      if (!agent) throw new Error("List agents before continuing a child so its project trust can be checked");
      extra = { project_trust: await this.trust(agent.cwd) };
    }
    if (!this.valid() || signal?.aborted) throw new Error("Subagent call cancelled before dispatch");
    const result = await this.client.call(name, args, signal, extra);
    const ticket = result._pi_delivery as Ticket | undefined;
    delete result._pi_delivery;
    if (!this.valid()) {
      if (ticket) await Promise.all(ticket.receipts.map(receipt => this.client.call("pi_release", { receipt }))).catch(() => {});
      throw new Error("Subagent result belongs to a detached parent session");
    }
    if (ticket) this.deliveries.set(id, { ticket, successful: false });
    this.startWatching();
    const content = [{ type: "text" as const, text: JSON.stringify(result) }];
    return { content, structuredContent: result as Awaited<ReturnType<ToolDefinition["execute"]>>["structuredContent"],
      details: { ...(ticket ? { metisSubagentReceipt: { ...ticket, sessionId: this.sessionId, scope: this.client.scope!, digest: digest(content) } satisfies ReceiptProof } : {}) } };
  }
  async command(args: string, ctx: ExtensionContext) {
    this.update(ctx);
    const [operation, target, ...message] = args.trim().split(/\s+/);
    if (operation === "stop" && target) return this.execute("pi_interrupt_agent", { agent_id: target, request_id: randomUUID() }, randomUUID(), ctx);
    if (operation === "continue" && target && message.length) return this.execute("pi_followup_task", { agent_id: target, request_id: randomUUID(), message: message.join(" ") }, randomUUID(), ctx);
    if (operation === "answer" && target) {
      const snapshot = await this.client.call("pi_inspect_agent", { agent_id: target, detail: "full" });
      const run = snapshot.run as { id: string } | undefined;
      if (!run) { ctx.ui.notify("No pending subagent question", "info"); return; }
      if (!ctx.hasUI) { ctx.ui.notify("Answering a subagent question requires an interactive Pi session", "warning"); return; }
      const result = await this.client.call("pi_wait_agent", { run_ids: [run.id], timeout_seconds: 0 });
      const ticket = result._pi_delivery as Ticket | undefined;
      try {
        const question = (result.questions as Array<{ id: string; method: string; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string }>)[0];
        if (!question) { ctx.ui.notify("No pending subagent question", "info"); return; }
        const title = question.title ?? question.message ?? "Subagent question";
        let answer: string | boolean | undefined;
        if (question.method === "confirm") {
          const choice = await ctx.ui.select(`${title}${question.message ? `\n${question.message}` : ""}`, ["Yes", "No"]);
          if (choice !== undefined) answer = choice === "Yes";
        } else if (question.method === "select") answer = await ctx.ui.select(title, question.options ?? []);
        else if (question.method === "editor") answer = await ctx.ui.editor(title, question.prefill);
        else if (question.method === "input") answer = await ctx.ui.input(title, question.placeholder);
        else throw new Error("Unsupported question type; use pi_answer_agent with an explicit answer");
        if (answer !== undefined && this.valid()) await this.client.call("pi_answer_agent", { agent_id: target, ui_request_id: question.id, answer, request_id: randomUUID() });
      } finally { if (ticket && this.valid()) await Promise.all(ticket.receipts.map(receipt => this.client.call("pi_release", { receipt }))); }
      return;
    }
    const snapshot = await this.client.call("pi_list_agents", {}); this.startWatching();
    if (!this.valid()) return;
    const agents = snapshot.agents as typeof this.agents;
    if (!agents.length) { ctx.ui.notify("No subagents in this session", "info"); return; }
    const entries = agents.map(agent => `${cleanName(agent.name)} · ${agent.state} · ${agent.id}`);
    if (ctx.mode !== "tui") { ctx.ui.notify(entries.join("\n"), "info"); return; }
    const selected = await ctx.ui.select(`Subagents · ${snapshot.total}${snapshot.omitted ? ` · ${snapshot.omitted} more not shown` : ""}`, entries);
    const agent = agents[entries.indexOf(selected ?? "")];
    if (agent) await this.openViewer(agent.id);
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.watchAbort.abort(); this.ctx.ui.setStatus("metis-subagents", undefined);
    this.viewerAbort?.abort();
    if (this.ctx.mode === "tui") this.ctx.ui.setWidget("metis-subagents", undefined);
    await this.client.close(); await this.watching;
  }
}
