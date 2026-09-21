// Transcript presentation state: the single display-order projection that
// drives exploration grouping, the tool→assistant-text separator and the
// thinking/text run distinction.
//
// It consumes read-only lifecycle events (no message content mutation, no
// session storage) and answers STABLE queries. Rendering NEVER mutates
// membership or boundaries: repaints, invalidate() storms and history
// rebuilds all get the same answer for the same logical message.

export type PresentationKind = "exploration" | "other-tool" | "assistant-text" | "transparent" | "barrier";

/** Cycle-free: thinking-view.ts has no imports at all. */
type ViewControl = import("./thinking-view.ts").ThinkingViewControl;

export interface ExplorationMember {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly order: number;
  isError: boolean;
  /** Image content blocks counted from the real tool result (not filenames). */
  images: number;
  done: boolean;
}

export interface ExplorationGroup {
  readonly id: number;
  readonly members: ExplorationMember[];
  /** open = semantic boundary not yet hit; more members may append. */
  open: boolean;
}

export interface ExplorationPlan {
  readonly groupId: number;
  readonly isHeaderOwner: boolean;
  readonly isFirstMember: boolean;
  readonly isLastMember: boolean;
  readonly memberIndex: number;
  readonly suppressLeadingSpacer: boolean;
  readonly running: boolean;
  readonly groupImages: number;
  /** Group total for THIS member as of the plan snapshot (per-member rows). */
  readonly memberImages: number;
}

/** Stable identity of one logical assistant message in this display stream. */
export type MessageViewKey = string;

/** One contiguous run of same-kind content (text or thinking) in a message. */
export interface TextRunPlan {
  readonly messageKey: MessageViewKey;
  /** Index of the text run within the message (0-based, text runs only). */
  readonly runIndex: number;
  /** Index of the run's first content block within message.content. */
  readonly firstContentIndex: number;
  /** True when real tool activity preceded this message in the segment. */
  readonly separatorBefore: boolean;
}

/** One thinking run's display lifecycle (host-parity: consecutive thinking
 * blocks are ONE run; the runIndex is the host's ordinal of RENDERED runs —
 * an all-empty run consumes no ordinal). */
export interface ThinkingRunPlan {
  readonly messageKey: MessageViewKey;
  readonly runIndex: number;
  /** Index of the run's first content block within message.content. */
  readonly firstContentIndex: number;
  /** Wall-clock ms when the run first contained non-empty thinking text. */
  readonly startedAt?: number;
  /** Wall-clock ms when the run closed (later non-thinking block or
   * message_end). Runs of restored history have no timing evidence. */
  readonly endedAt?: number;
  /** endedAt - startedAt when both are known; never fabricated. */
  readonly thinkingMs?: number;
  readonly ended: boolean;
}

export interface TranscriptEvent {
  type:
    | "turn_start"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_end";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  imageCount?: number;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; thinking?: string }>;
    stopReason?: string;
  };
  /** Branch/session generation bump (branch switch, reload). */
  generation?: number;
}

export type MessageBlock = { type: string; text?: string; thinking?: string };

/** Canonical read-only content-block mapping, shared by the event boundary
 * (extension.ts toStateMessage) and the render adapter (transcript-adapter.ts):
 * one policy so a new block field cannot be added at one site only. Tolerates
 * null/undefined entries and a non-array payload (→ []). */
export function normalizeMessageBlocks(blocks: unknown): MessageBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => {
    const b = (block ?? {}) as Record<string, unknown>;
    return { type: String(b.type ?? ""), text: typeof b.text === "string" ? b.text : undefined, thinking: typeof b.thinking === "string" ? b.thinking : undefined };
  });
}

/**
 * True when a message contains NON-EMPTY visible TEXT (thinking does not
 * count: thinking must not steal the separator's text qualification).
 */
export function assistantHasVisibleText(message: TranscriptEvent["message"]): boolean {
  if (!message || message.role !== "assistant") return false;
  return message.content.some((block) => block.type === "text" && !!block.text?.trim());
}

/** True when a message contains any visible thinking content. */
export function assistantHasVisibleThinking(message: TranscriptEvent["message"]): boolean {
  if (!message || message.role !== "assistant") return false;
  return message.content.some((block) => block.type === "thinking" && !!block.thinking?.trim());
}

/** Content-shape runs of one message: contiguous same-kind blocks. */
export interface ThinkingRunSlot {
  readonly runIndex: number;
  readonly firstContentIndex: number;
  /** True when a non-thinking block follows the run (the host's rebuild loop
   * breaks there — the same boundary that closes the run's clock). */
  readonly endedInContent: boolean;
}

/** The content-block fields the run merge reads (structural: the adapter's
 * raw message blocks and the transcript's normalized blocks both fit). */
export interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

export interface SemanticRun {
  kind: "text" | "thinking";
  /** Index of the run's first content block. */
  firstContentIndex: number;
  /** The run has visible content: a non-empty text block (text run) or at
   * least one non-empty thinking block (thinking run). */
  nonEmpty: boolean;
  /** A toolCall/unknown block: it renders nothing of its own but BREAKS any
   * adjacent thinking run (the host's rebuild has one MouseRegion per
   * contiguous thinking run between other blocks). */
  barrier?: boolean;
  /** Thinking runs only: a block follows the run, so the host's rebuild loop
   * cannot extend it any further and its clock is closed. */
  ended?: boolean;
  /** Host thinkingRunIndex (ordinal of RENDERED thinking runs, in content
   * order); thinking runs only. An all-empty run renders nothing and takes no
   * ordinal, exactly like the host. */
  thinkingRunIndex?: number;
}

/**
 * Contiguous same-kind visible runs of one message's content — THE run merge,
 * shared by the host-parity thinking clocks (renderedThinkingRuns) and the
 * transcript rebuild coordinator so the two can never drift apart.
 *
 * Host parity: each NON-EMPTY text block is its own child; consecutive
 * thinking blocks merge into ONE run ONLY when truly adjacent. ANY other
 * block breaks the run — including an EMPTY text block: the host's rebuild
 * loop breaks on the first non-thinking block regardless of emptiness.
 */
export function semanticRuns(content: ReadonlyArray<ContentBlockLike>): SemanticRun[] {
  const runs: SemanticRun[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;
    const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : null;
    if (!kind) {
      runs.push({ kind: "text", firstContentIndex: i, nonEmpty: false, barrier: true });
      continue;
    }
    const nonEmpty = kind === "text"
      ? (typeof block.text === "string" ? !!block.text.trim() : false)
      : (typeof block.thinking === "string" ? !!block.thinking.trim() : false);
    if (kind === "text") {
      // Every text block (even empty) breaks a thinking run; only non-empty
      // ones create a run of their own.
      runs.push({ kind, firstContentIndex: i, nonEmpty });
      continue;
    }
    const last = runs.at(-1);
    if (last && last.kind === "thinking") {
      last.nonEmpty = last.nonEmpty || nonEmpty;
      continue;
    }
    runs.push({ kind, firstContentIndex: i, nonEmpty, ended: true });
  }
  // A thinking run that reaches the end of the content cannot grow either:
  // the host's rebuild loop simply runs out of blocks.
  const last = runs.at(-1);
  if (last?.kind === "thinking" && content.at(-1)?.type === "thinking") last.ended = false;
  // Host parity: the host's thinkingRunIndex counts only RENDERED (non-empty)
  // thinking runs, in content order.
  let thinkingOrdinal = 0;
  for (const run of runs) {
    if (run.kind === "thinking" && run.nonEmpty) run.thinkingRunIndex = thinkingOrdinal++;
  }
  return runs;
}

/**
 * Thinking runs of one message content, matching the host rebuild exactly:
 * consecutive thinking blocks merge into ONE run; a run whose blocks are ALL
 * empty produces no child and consumes no runIndex. Derived from the shared
 * semanticRuns traversal.
 */
export function renderedThinkingRuns(
  content: Array<{ type: string; thinking?: string }>,
): ThinkingRunSlot[] {
  const slots: ThinkingRunSlot[] = [];
  for (const run of semanticRuns(content)) {
    if (run.kind !== "thinking" || !run.nonEmpty) continue;
    slots.push({ runIndex: run.thinkingRunIndex!, firstContentIndex: run.firstContentIndex, endedInContent: run.ended === true });
  }
  return slots;
}

interface ThinkingRunState {
  firstContentIndex: number;
  startedAt?: number;
  endedAt?: number;
  /** Every non-empty thinking run gets its own view control: which shape it renders in,
   * its peek scroll position, and a pending single click. Lives with the plan so a
   * host rebuild (streaming, resize, branch re-render) keeps the user's choice. */
  viewControl?: ViewControl;
}

interface MessagePlan {
  readonly key: MessageViewKey;
  finalized: boolean;
  /** Separator is owed before the FIRST non-empty text run of this message. */
  separatorBefore: boolean;
  /** Number of content blocks seen so far (update-count independent). */
  blockCount: number;
  /** Per-thinking-run clocks; entries appear as runs render and never reset. */
  thinkingRuns: ThinkingRunState[];
}

/** Canonical fingerprint of a finalized message's content: the host
 * re-renders finalized transcripts through message clones, so sealed-plan
 * reuse is keyed by normalized content + stopReason (never object identity). */
function sealedFingerprint(content: Array<{ type: string; text?: string; thinking?: string }>, stopReason?: string): string {
  return `${stopReason ?? ""}|${JSON.stringify(content)}`;
}

/** Bounded store for sealed-plan fingerprints (long sessions must not grow
 * the content-JSON map without limit; an evicted entry only costs the honest
 * timing-less fallback if that message is re-rendered later). */
const MAX_SEALED_FINGERPRINTS = 256;

const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);

export class TranscriptState {
  private generation = 0;
  private nextGroupId = 1;
  private readonly groups = new Map<number, ExplorationGroup>();
  private readonly memberOf = new Map<string, number>();
  private lastNode: PresentationKind = "barrier";
  private openGroupId: number | undefined;
  // A plan keeps its identity when finalized; components and messages share that key.
  private readonly messagePlans = new Map<MessageViewKey, MessagePlan>();
  private nextMessageSeq = 1;
  private identityByObject = new WeakMap<object, MessageViewKey>();
  /**
   * Content fingerprints of sealed plans. The host re-renders FINALIZED
   * transcripts through a message CLONE (a different object), so the object
   * anchor cannot match; the fingerprint lets the clone reuse the original
   * sealed plan — with its real thinking clocks — instead of registering a
   * timing-less duplicate.
   */
  private readonly sealedFingerprints = new Map<string, MessageViewKey>();
  private sessionKey = "default";
  /** Views (groups/heads) whose plan changed since the last takeDirtyViews. */
  private dirtyViews = new Set<string>();

  /** Wall clock is injectable so tests can drive run durations deterministically. */
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  resetSession(sessionKey = "default"): void {
    // Pending single clicks die with their transcript (no timers outlive a session).
    for (const plan of this.messagePlans.values()) {
      for (const run of plan.thinkingRuns) run.viewControl?.cancel();
    }
    this.generation += 1;
    this.sessionKey = sessionKey;
    this.groups.clear();
    this.memberOf.clear();
    this.lastNode = "barrier";
    this.openGroupId = undefined;
    this.messagePlans.clear();
    this.identityByObject = new WeakMap();
    this.nextMessageSeq = 1;
    this.sealedFingerprints.clear();
    this.dirtyViews.clear();
  }

  /** Stable key for a streaming assistant message (object identity first). */
  messageKeyFor(sourceObject?: object): MessageViewKey {
    if (sourceObject) {
      const known = this.identityByObject.get(sourceObject);
      if (known) return known;
    }
    // Without an object anchor the host streaming model re-uses one message
    // object per turn, so the CURRENT open assistant plan (if any) continues.
    for (const plan of this.messagePlans.values()) {
      if (!plan.finalized && plan.blockCount > 0) {
        return plan.key;
      }
    }
    return `${this.generation}:${this.nextMessageSeq++}`;
  }

  apply(event: TranscriptEvent, sourceObject?: object): void {
    if (event.generation !== undefined && event.generation !== this.generation) {
      this.resetSession(this.sessionKey);
    }
    switch (event.type) {
      case "turn_start":
        break;
      case "message_start": {
        const message = event.message;
        if (!message) break;
        if (message.role === "user") {
          this.applyUserBoundary();
          break;
        }
        if (message.role === "assistant") {
          const known = sourceObject ? this.identityOf(sourceObject) : undefined;
          const key = known && !this.messagePlans.get(known)?.finalized
            ? known : `${this.generation}:${this.nextMessageSeq++}`;
          this.ensureMessagePlan(key, sourceObject);
        }
        break;
      }
      case "message_update": {
        const message = event.message;
        if (!message || message.role !== "assistant") break;
        const key = this.messageKeyFor(sourceObject);
        const plan = this.ensureMessagePlan(key, sourceObject);
        if (plan.finalized) break;
        const grew = message.content.length > plan.blockCount;
        plan.blockCount = Math.max(plan.blockCount, message.content.length);
        // ONLY VISIBLE content is a boundary: a tool-call-only message_update
        // that merely appends toolCall blocks must NOT close the exploration
        // group or mark assistant-text.
        const hasThinking = assistantHasVisibleThinking(message);
        const visible = assistantHasVisibleText(message) || hasThinking;
        // Per-run clocks (host-parity runs). Start: first sighting of a
        // rendered run — repeated cumulative updates never reset it. End: the
        // first non-thinking block after the run; message_end closes the rest.
        for (const run of renderedThinkingRuns(message.content)) {
          const state = plan.thinkingRuns[run.runIndex] ??= {
            firstContentIndex: run.firstContentIndex,
          };
          if (state.startedAt === undefined) state.startedAt = this.now();
          if (state.endedAt === undefined && run.endedInContent) state.endedAt = this.now();
        }
        if (visible) {
          this.closeOpenGroup();
          this.lastNode = "assistant-text";
          this.dirtyViews.add(key);
        } else if (grew) {
          this.dirtyViews.add(key);
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (!message) break;
        if (message.role === "user") {
          this.applyUserBoundary();
          break;
        }
        if (message.role === "assistant") {
          const key = this.messageKeyFor(sourceObject);
          const plan = this.messagePlans.get(key);
          if (plan && !plan.finalized) {
            plan.finalized = true;
            for (const run of plan.thinkingRuns) run.endedAt ??= this.now();
            this.rememberFinalized(message, key);
          }
        }
        break;
      }
      case "tool_execution_start": {
        if (!event.toolCallId || !event.toolName) break;
        if (EXPLORATION_TOOLS.has(event.toolName)) {
          this.joinOrCreateGroup(event.toolCallId, event.toolName);
          this.lastNode = "exploration";
        } else {
          this.closeOpenGroup();
          this.lastNode = "other-tool";
        }
        break;
      }
      case "tool_execution_end": {
        if (!event.toolCallId) break;
        const groupId = this.memberOf.get(event.toolCallId);
        if (groupId !== undefined) {
          const group = this.groups.get(groupId);
          const index = group?.members.findIndex((m) => m.toolCallId === event.toolCallId) ?? -1;
          const member = group?.members[index];
          if (member && group) {
            member.done = true;
            member.isError = event.isError === true;
            member.images = event.imageCount ?? member.images;
            // Images grew the group total: the previous tail's aggregated
            // notice must refresh (footer ownership moves on append anyway).
            this.dirtyViews.add(`group:${groupId}`);
            if (index === group.members.length - 1) this.dirtyViews.add(`member:${member.toolCallId}`);
            if (member.isError) {
              group.open = false;
              if (this.openGroupId === groupId) this.openGroupId = undefined;
            }
          }
        } else {
          this.closeOpenGroup();
          this.lastNode = "other-tool";
        }
        break;
      }
    }
  }

  private ensureMessagePlan(key: MessageViewKey, sourceObject?: object): MessagePlan {
    if (sourceObject) this.identityByObject.set(sourceObject, key);
    let plan = this.messagePlans.get(key);
    if (!plan) {
      plan = { key, finalized: false, separatorBefore: this.lastNode === "exploration" || this.lastNode === "other-tool", blockCount: 0, thinkingRuns: [] };
      this.messagePlans.set(key, plan);
    }
    return plan;
  }

  private rememberFinalized(message: NonNullable<TranscriptEvent["message"]>, key: MessageViewKey): void {
    const fingerprint = sealedFingerprint(message.content, message.stopReason);
    if (!this.sealedFingerprints.has(fingerprint) && this.sealedFingerprints.size >= MAX_SEALED_FINGERPRINTS) {
      this.sealedFingerprints.delete(this.sealedFingerprints.keys().next().value!);
    }
    this.sealedFingerprints.set(fingerprint, key);
  }

  private applyUserBoundary(): void {
    this.closeOpenGroup();
    this.lastNode = "barrier";
  }

  private closeOpenGroup(): void {
    if (this.openGroupId !== undefined) {
      const group = this.groups.get(this.openGroupId);
      if (group) group.open = false;
      this.openGroupId = undefined;
    }
  }

  private joinOrCreateGroup(toolCallId: string, toolName: string): void {
    const existing = this.memberOf.get(toolCallId);
    if (existing !== undefined) return;
    let group = this.openGroupId === undefined ? undefined : this.groups.get(this.openGroupId);
    if (!group) {
      group = { id: this.nextGroupId++, members: [], open: true };
      this.groups.set(group.id, group);
      this.openGroupId = group.id;
    }
    const previousTail = group.members.at(-1);
    group.members.push({ toolCallId, toolName, order: group.members.length, isError: false, images: 0, done: false });
    this.memberOf.set(toolCallId, group.id);
    // Appending moves footer ownership from the old tail to the new member.
    if (previousTail) this.dirtyViews.add(`member:${previousTail.toolCallId}`);
    this.dirtyViews.add(`member:${toolCallId}`);
    this.dirtyViews.add(`group:${group.id}`);
  }

  /** Display plan for an exploration member row (or undefined if ungrouped). */
  explorationPlan(toolCallId: string): ExplorationPlan | undefined {
    const groupId = this.memberOf.get(toolCallId);
    if (groupId === undefined) return undefined;
    const group = this.groups.get(groupId);
    if (!group) return undefined;
    const index = group.members.findIndex((m) => m.toolCallId === toolCallId);
    if (index < 0) return undefined;
    const member = group.members[index]!;
    const anyRunning = group.members.some((m) => !m.done);
    return {
      groupId,
      isHeaderOwner: index === 0,
      isFirstMember: index === 0,
      isLastMember: index === group.members.length - 1,
      memberIndex: index,
      suppressLeadingSpacer: index > 0,
      running: anyRunning,
      groupImages: group.members.reduce((sum, m) => sum + m.images, 0),
      memberImages: member.images,
    };
  }

  /**
   * STABLE per-run query for the assistant decoration layer. Pure read: safe
   * to call on every updateContent rebuild; the answer never flips for the
   * same logical message.
   */
  textRunPlan(messageKey: MessageViewKey, runIndex = 0): TextRunPlan | undefined {
    const plan = this.messagePlans.get(messageKey);
    if (!plan) return undefined;
    if (runIndex !== 0) return undefined; // only the first text run of a message carries the boundary
    return {
      messageKey: plan.key,
      runIndex,
      firstContentIndex: 0,
      separatorBefore: plan.separatorBefore,
    };
  }

  /** One thinking run's lifecycle for a message (host runIndex semantics). */
  thinkingRunPlan(messageKey: MessageViewKey, runIndex: number): ThinkingRunPlan | undefined {
    const plan = this.messagePlans.get(messageKey);
    const state = plan?.thinkingRuns[runIndex];
    if (!plan || !state) return undefined;
    return {
      messageKey: plan.key,
      runIndex,
      firstContentIndex: state.firstContentIndex,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      thinkingMs: state.startedAt !== undefined
        ? Math.max(0, (state.endedAt ?? this.now()) - state.startedAt)
        : undefined,
      ended: state.endedAt !== undefined,
    };
  }

  /** All thinking runs of a message, in host runIndex order. */
  thinkingRunPlans(messageKey: MessageViewKey): readonly ThinkingRunPlan[] {
    const plan = this.messagePlans.get(messageKey);
    if (!plan) return [];
    return plan.thinkingRuns.map((_, runIndex) => this.thinkingRunPlan(messageKey, runIndex)!);
  }

  /**
   * The per-run view control (shape + peek scroll + click gesture). Stored with
   * the run's clock so it survives every rebuild; for a message whose plan was
   * never registered (unknown transcript shape) a transient control is handed
   * back — the run then behaves correctly, it just cannot persist. Idempotent:
   * the factory runs at most once per run.
   */
  thinkingViewControl(messageKey: MessageViewKey, runIndex: number, create: () => ViewControl): ViewControl {
    const run = this.messagePlans.get(messageKey)?.thinkingRuns[runIndex];
    if (!run) return create();
    return (run.viewControl ??= create());
  }

  /**
   * Which message key does this live component currently render? The adapter
   * resolves identity from the host message object (streaming-anchored).
   */
  identityOf(sourceObject: object): MessageViewKey | undefined {
    return this.identityByObject.get(sourceObject);
  }

  /** Convenience for tests/history: register a finalized message explicitly.
   * Thinking runs are synthesized from the content with no timing evidence —
   * they count as ended (the message is final) but carry no duration. A
   * message whose content fingerprint already has a sealed plan (the host
   * re-renders finalized messages through clones) reuses that plan so real
   * thinking clocks survive the re-render. */
  registerFinalizedMessage(message: NonNullable<TranscriptEvent["message"]>, followsTools: boolean, sourceObject?: object): MessageViewKey {
    const fingerprint = sealedFingerprint(message.content, message.stopReason);
    const existing = this.sealedFingerprints.get(fingerprint);
    if (existing && this.messagePlans.has(existing)) {
      if (sourceObject) this.identityByObject.set(sourceObject, existing);
      return existing;
    }
    const key = `${this.generation}:${this.nextMessageSeq++}`;
    this.messagePlans.set(key, {
      key,
      finalized: true,
      separatorBefore: followsTools,
      blockCount: message.content.length,
      thinkingRuns: renderedThinkingRuns(message.content).map((run) => ({
        firstContentIndex: run.firstContentIndex,
        endedAt: this.now(),
      })),
    });
    this.rememberFinalized(message, key);
    if (sourceObject) this.identityByObject.set(sourceObject, key);
    return key;
  }

  /** Keys whose plans changed since the last call (grouped refresh hints). */
  takeDirtyViews(): string[] {
    const keys = [...this.dirtyViews];
    this.dirtyViews.clear();
    return keys;
  }

  /**
   * Adopt the CURRENT open assistant plan for an unanchored component
   * (updateContent during streaming, where the host never passes the message
   * object identity to events). Maps the component to that plan's key so
   * later rebuilds reuse the SAME stable identity. Returns the key or
   * undefined when there is no open plan to adopt.
   */
  adoptOpenAssistantPlan(
    content: Array<{ type: string; text?: string; thinking?: string }>,
    component: object,
  ): MessageViewKey | undefined {
    let adopted: MessageViewKey | undefined;
    for (const plan of this.messagePlans.values()) {
      if (plan.finalized) continue;
      if (plan.blockCount < content.length) continue;
      adopted = plan.key; // keep the LAST match: insertion order = stream order
    }
    if (adopted) {
      this.identityByObject.set(component, adopted);
      this.dirtyViews.add(adopted);
    }
    return adopted;
  }

  /** Current segment head (for finalized-message registration fallback). */
  lastNodeKind(): PresentationKind {
    return this.lastNode;
  }

  groupMemberIds(groupId: number): string[] {
    return this.groups.get(groupId)?.members.map((m) => m.toolCallId) ?? [];
  }

  groupOpen(toolCallId: string): boolean {
    const groupId = this.memberOf.get(toolCallId);
    return groupId !== undefined && this.groups.get(groupId)?.open === true;
  }

}
