// Transcript presentation state: the single display-order projection that
// drives exploration grouping, the tool→assistant-text separator and the
// thinking/text run distinction.
//
// It consumes read-only lifecycle events (no message content mutation, no
// session storage) and answers STABLE queries. Rendering NEVER mutates
// membership or boundaries: repaints, invalidate() storms and history
// rebuilds all get the same answer for the same logical message.

export type PresentationKind = "exploration" | "other-tool" | "assistant-text" | "transparent" | "barrier";

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

/** Zero-height assistant messages (tool-call-only, nothing visible). */
export function isToolCallOnlyAssistant(message: TranscriptEvent["message"]): boolean {
  if (!message || message.role !== "assistant") return false;
  const visible = assistantHasVisibleText(message) || assistantHasVisibleThinking(message);
  const toolCalls = message.content.some((block) => block.type === "toolCall");
  return toolCalls && !visible;
}

/** Content-shape runs of one message: contiguous same-kind blocks. */
export interface ThinkingRunSlot {
  readonly runIndex: number;
  readonly firstContentIndex: number;
  /** True when a non-thinking block follows the run (the host's rebuild loop
   * breaks there — the same boundary that closes the run's clock). */
  readonly endedInContent: boolean;
}

/**
 * Thinking runs of one message content, matching the host rebuild exactly:
 * consecutive thinking blocks merge into ONE run; a run whose blocks are ALL
 * empty produces no child and consumes no runIndex; ANY non-thinking block
 * (text, even empty, toolCall, …) breaks the run.
 */
export function renderedThinkingRuns(
  content: Array<{ type: string; thinking?: string }>,
): ThinkingRunSlot[] {
  const slots: ThinkingRunSlot[] = [];
  let runIndex = 0;
  for (let i = 0; i < content.length; ) {
    if (content[i]!.type !== "thinking") {
      i += 1;
      continue;
    }
    const firstContentIndex = i;
    let nonEmpty = false;
    for (; i < content.length && content[i]!.type === "thinking"; i += 1) {
      if (content[i]!.thinking?.trim()) nonEmpty = true;
    }
    if (nonEmpty) slots.push({ runIndex: runIndex++, firstContentIndex, endedInContent: i < content.length });
  }
  return slots;
}

interface ThinkingRunState {
  runIndex: number;
  firstContentIndex: number;
  startedAt?: number;
  endedAt?: number;
}

interface MessagePlan {
  readonly key: MessageViewKey;
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
  /**
   * Plans keyed by STABLE logical message identity. The identity survives
   * streaming object replacement: host streaming re-uses one AssistantMessage
   * object, and history replay assigns identities in the same deterministic
   * order (generation + per-generation message sequence).
   */
  private readonly messagePlans = new Map<MessageViewKey, MessagePlan>();
  private nextMessageSeq = 1;
  /** Identity of the assistant message currently streaming (object-anchored). */
  private readonly identityByObject = new WeakMap<object, MessageViewKey>();
  /** open→sealed key aliases so adopted components survive message_end. */
  private readonly openKeyAliases = new Map<string, MessageViewKey>();
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
    this.generation += 1;
    this.sessionKey = sessionKey;
    this.groups.clear();
    this.memberOf.clear();
    this.lastNode = "barrier";
    this.openGroupId = undefined;
    this.messagePlans.clear();
    this.nextMessageSeq = 1;
    this.sealedFingerprints.clear();
    this.dirtyViews.clear();
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentSessionKey(): string {
    return this.sessionKey;
  }

  /** Stable key for a streaming assistant message (object identity first). */
  messageKeyFor(message: NonNullable<TranscriptEvent["message"]>, sourceObject?: object): MessageViewKey {
    if (sourceObject) {
      const known = this.identityByObject.get(sourceObject);
      if (known) return known;
    }
    // Without an object anchor the host streaming model re-uses one message
    // object per turn, so the CURRENT open assistant plan (if any) continues.
    for (const plan of this.messagePlans.values()) {
      if (plan.key.startsWith(`${this.generation}:`) && plan.blockCount > 0 && (plan.key as string).endsWith(":open")) {
        return plan.key;
      }
    }
    return `${this.generation}:${this.nextMessageSeq++}:open`;
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
          // A NEW logical message: ALWAYS a fresh plan — message_start is a
          // message boundary by definition. The group is NOT closed here —
          // tool-call-only assistant messages are transparent: the group must
          // survive them (closeOpenGroup happens in message_update below).
          const key = sourceObject && this.identityByObject.get(sourceObject)
            ? this.identityByObject.get(sourceObject)!
            : `${this.generation}:${this.nextMessageSeq++}:open`;
          if (sourceObject) this.identityByObject.set(sourceObject, key);
          if (!this.messagePlans.has(key)) {
            const followsTools = this.lastNode === "exploration" || this.lastNode === "other-tool";
            this.messagePlans.set(key, { key, separatorBefore: followsTools, blockCount: 0, thinkingRuns: [] });
          }
        }
        break;
      }
      case "message_update": {
        const message = event.message;
        if (!message || message.role !== "assistant") break;
        const key = this.messageKeyFor(message, sourceObject);
        if (sourceObject) this.identityByObject.set(sourceObject, key);
        let plan = this.messagePlans.get(key);
        if (!plan) {
          const followsTools = this.lastNode === "exploration" || this.lastNode === "other-tool";
          plan = { key, separatorBefore: followsTools, blockCount: 0, thinkingRuns: [] };
          this.messagePlans.set(key, plan);
        }
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
          let state = plan.thinkingRuns.find((r) => r.runIndex === run.runIndex);
          if (!state) {
            state = { runIndex: run.runIndex, firstContentIndex: run.firstContentIndex };
            plan.thinkingRuns.push(state);
          }
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
          const key = this.messageKeyFor(message, sourceObject);
          const plan = this.messagePlans.get(key);
          // Seal identity: further updates with the same object map here; the
          // open key becomes an alias of the sealed one (WeakMap is not
          // iterable, so rewrites go through the alias table).
          const sealedKey = key.replace(/:open$/, ":sealed");
          if (plan) {
            // A run still streaming at message_end ends here (conservative
            // close). Runs are copied so the sealed plan owns its clocks.
            const sealed: MessagePlan = {
              ...plan,
              key: sealedKey,
              thinkingRuns: plan.thinkingRuns.map((run) => {
                const copy = { ...run };
                if (copy.endedAt === undefined) copy.endedAt = this.now();
                return copy;
              }),
            };
            this.messagePlans.set(sealedKey, sealed);
            this.sealedFingerprints.set(sealedFingerprint(message.content, message.stopReason), sealedKey);
          }
          this.openKeyAliases.set(key, sealedKey);
          this.messagePlans.delete(key);
          if (!assistantHasVisibleText(message) && !assistantHasVisibleThinking(message)) {
            // Tool-call-only: transparent, does not disturb the segment.
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
    if (this.openGroupId !== undefined) {
      const group = this.groups.get(this.openGroupId)!;
      const previousTail = group.members.at(-1);
      group.members.push({ toolCallId, toolName, order: group.members.length, isError: false, images: 0, done: false });
      this.memberOf.set(toolCallId, group.id);
      // Footer migration: the OLD tail loses the aggregated notice, the new
      // tail gains it. Mark both dirty (plus the header's running state).
      if (previousTail) this.dirtyViews.add(`member:${previousTail.toolCallId}`);
      this.dirtyViews.add(`member:${toolCallId}`);
      this.dirtyViews.add(`group:${group.id}`);
      return;
    }
    const id = this.nextGroupId++;
    const group: ExplorationGroup = { id, members: [], open: true };
    group.members.push({ toolCallId, toolName, order: 0, isError: false, images: 0, done: false });
    this.groups.set(id, group);
    this.memberOf.set(toolCallId, id);
    this.openGroupId = id;
    this.dirtyViews.add(`member:${toolCallId}`);
    this.dirtyViews.add(`group:${id}`);
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
    const state = plan?.thinkingRuns.find((run) => run.runIndex === runIndex);
    if (!plan || !state) return undefined;
    return {
      messageKey: plan.key,
      runIndex: state.runIndex,
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
    return [...plan.thinkingRuns]
      .sort((a, b) => a.runIndex - b.runIndex)
      .map((run) => this.thinkingRunPlan(messageKey, run.runIndex)!);
  }

  /**
   * Which message key does this live component currently render? The adapter
   * resolves identity from the host message object (streaming-anchored).
   */
  identityOf(sourceObject: object): MessageViewKey | undefined {
    const direct = this.identityByObject.get(sourceObject);
    if (!direct) return undefined;
    return this.openKeyAliases.get(direct) ?? direct;
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
    const key = `${this.generation}:${this.nextMessageSeq++}:sealed`;
    this.messagePlans.set(key, {
      key,
      separatorBefore: followsTools,
      blockCount: message.content.length,
      thinkingRuns: renderedThinkingRuns(message.content).map((run) => ({
        runIndex: run.runIndex,
        firstContentIndex: run.firstContentIndex,
        endedAt: this.now(),
      })),
    });
    while (this.sealedFingerprints.size >= MAX_SEALED_FINGERPRINTS) {
      const oldest = this.sealedFingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.sealedFingerprints.delete(oldest);
    }
    this.sealedFingerprints.set(fingerprint, key);
    if (sourceObject) this.identityByObject.set(sourceObject, key);
    return key;
  }

  /** Whether a message has a plan at all (history replay completeness). */
  hasMessagePlan(messageKey: MessageViewKey): boolean {
    return this.messagePlans.has(messageKey);
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
      if (!plan.key.startsWith(`${this.generation}:`) || !(plan.key as string).endsWith(":open")) continue;
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

  static readonly EXPLORATION_TOOLS = EXPLORATION_TOOLS;
}
