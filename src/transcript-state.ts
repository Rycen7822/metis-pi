// Transcript presentation state: the single display-order projection that
// drives exploration grouping, the tool→assistant-text separator and the
// thinking/text run distinction.
//
// It consumes read-only lifecycle events (no message content mutation, no
// session storage) and answers STABLE queries:
//   - exploration plan for a toolCallId (group, header owner, gutter shape)
//   - per-message text-run plans keyed by a stable logical message identity
//
// Rendering NEVER mutates membership or boundaries. Queries are pure reads of
// precomputed plans; repaints, invalidate() storms and history rebuilds all
// get the same answer for the same logical message.

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
 * count: 3.5 — thinking must not steal the separator's text qualification).
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
export function contentRuns(message: NonNullable<TranscriptEvent["message"]>): Array<{
  kind: "text" | "thinking";
  firstContentIndex: number;
  nonEmpty: boolean;
}> {
  const runs: Array<{ kind: "text" | "thinking"; firstContentIndex: number; nonEmpty: boolean }> = [];
  for (let i = 0; i < message.content.length; i++) {
    const block = message.content[i]!;
    const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : null;
    if (!kind) continue;
    const last = runs.at(-1);
    if (last && last.kind === kind) {
      if ((kind === "text" ? block.text : block.thinking)?.trim()) last.nonEmpty = true;
      continue;
    }
    runs.push({
      kind,
      firstContentIndex: i,
      nonEmpty: !!((kind === "text" ? block.text : block.thinking)?.trim()),
    });
  }
  return runs;
}

interface MessagePlan {
  readonly key: MessageViewKey;
  /** Separator is owed before the FIRST non-empty text run of this message. */
  separatorBefore: boolean;
  /** Number of content blocks seen so far (update-count independent). */
  blockCount: number;
}

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
  private sessionKey = "default";
  /** Views (groups/heads) whose plan changed since the last takeDirtyViews. */
  private dirtyViews = new Set<string>();

  resetSession(sessionKey = "default"): void {
    this.generation += 1;
    this.sessionKey = sessionKey;
    this.groups.clear();
    this.memberOf.clear();
    this.lastNode = "barrier";
    this.openGroupId = undefined;
    this.messagePlans.clear();
    this.nextMessageSeq = 1;
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
          // message boundary by definition. (messageKeyFor's "continue the
          // open plan" fallback must not glue distinct messages together.)
          // The group is NOT closed here — tool-call-only assistant messages
          // are transparent (4.2): the group must survive them and keep
          // accepting members. closeOpenGroup happens when the message
          // actually shows text/thinking (message_update below).
          const key = sourceObject && this.identityByObject.get(sourceObject)
            ? this.identityByObject.get(sourceObject)!
            : `${this.generation}:${this.nextMessageSeq++}:open`;
          if (sourceObject) this.identityByObject.set(sourceObject, key);
          if (!this.messagePlans.has(key)) {
            const followsTools = this.lastNode === "exploration" || this.lastNode === "other-tool";
            this.messagePlans.set(key, { key, separatorBefore: followsTools, blockCount: 0 });
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
          plan = { key, separatorBefore: followsTools, blockCount: 0 };
          this.messagePlans.set(key, plan);
        }
        const grew = message.content.length > plan.blockCount;
        plan.blockCount = Math.max(plan.blockCount, message.content.length);
        if (grew || assistantHasVisibleText(message) || assistantHasVisibleThinking(message)) {
          this.closeOpenGroup();
          this.lastNode = "assistant-text";
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
          // Seal identity: further updates with the same object map here, but
          // the key loses its ":open" marker meaning nothing else joins it.
          // Components that ADOPTED the open plan keep their identity: the
          // open key becomes an alias of the sealed one (WeakMap is not
          // iterable, so rewrite happens via the alias table).
          const sealedKey = key.replace(/:open$/, ":sealed");
          if (plan) this.messagePlans.set(sealedKey, { ...plan, key: sealedKey });
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
   * same logical message (3.1/3.2 fix — the old takeTextPlan() consumed
   * global pending state here, so the line vanished after the first rebuild).
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

  /**
   * Which message key does this live component currently render? The adapter
   * resolves identity from the host message object (streaming-anchored).
   */
  identityOf(sourceObject: object): MessageViewKey | undefined {
    const direct = this.identityByObject.get(sourceObject);
    if (!direct) return undefined;
    return this.openKeyAliases.get(direct) ?? direct;
  }

  /** Convenience for tests/history: register a finalized message explicitly. */
  registerFinalizedMessage(message: NonNullable<TranscriptEvent["message"]>, followsTools: boolean, sourceObject?: object): MessageViewKey {
    const key = `${this.generation}:${this.nextMessageSeq++}:sealed`;
    this.messagePlans.set(key, { key, separatorBefore: followsTools, blockCount: message.content.length });
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
