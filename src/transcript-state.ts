// Transcript presentation state: the single display-order projection that
// drives BOTH exploration grouping and the tool→assistant-text separator.
//
// It consumes read-only lifecycle events (no message content mutation, no
// session storage) and answers pure queries:
//   - exploration plan for a toolCallId (group, header owner, gutter shape)
//   - whether the next non-empty assistant text needs a separator line
//
// Rendering NEVER mutates membership or boundaries (render order is not
// transcript order); components only read the plan computed from events.

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
}

export interface TextPlan {
  readonly segmentKey: string;
  readonly separatorBefore: boolean;
}

const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EXPLORATION_TOOLS_WITH_PATH: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export interface TranscriptEvent {
  type:
    | "turn_start"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_end";
  // tool events
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  imageCount?: number;
  // assistant message events: content shape the display layer may show
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; thinking?: string }>;
    stopReason?: string;
  };
  /** Branch/session generation bump (branch switch, reload). */
  generation?: number;
}

/** True when a message would render as visible assistant text/thinking. */
export function assistantHasVisibleText(message: TranscriptEvent["message"]): boolean {
  if (!message || message.role !== "assistant") return false;
  return message.content.some((block) => (block.type === "text" && !!block.text?.trim()) || (block.type === "thinking" && !!block.thinking?.trim()));
}

/** Zero-height assistant messages (tool-call-only, nothing visible). */
export function isToolCallOnlyAssistant(message: TranscriptEvent["message"]): boolean {
  if (!message || message.role !== "assistant") return false;
  const visible = assistantHasVisibleText(message);
  const toolCalls = message.content.some((block) => block.type === "toolCall");
  return toolCalls && !visible;
}

export class TranscriptState {
  private generation = 0;
  private nextGroupId = 1;
  /** Groups by id, in display order of creation. */
  private readonly groups = new Map<number, ExplorationGroup>();
  /** toolCallId → group id. */
  private readonly memberOf = new Map<string, number>();
  /** Display-order record: what appeared between tools. */
  private lastNode: PresentationKind = "barrier";
  /** Open group that the next exploration tool may join. */
  private openGroupId: number | undefined;
  /** Separator bookkeeping per assistant text segment. */
  private separatorPending = false;
  private nextSegmentId = 1;
  private readonly separatorDone = new Set<string>();
  /** session/branch identity for ViewKey-ish isolation. */
  private sessionKey = "default";

  resetSession(sessionKey = "default"): void {
    this.generation += 1;
    this.sessionKey = sessionKey;
    this.groups.clear();
    this.memberOf.clear();
    this.lastNode = "barrier";
    this.openGroupId = undefined;
    this.separatorPending = false;
    this.separatorDone.clear();
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentSessionKey(): string {
    return this.sessionKey;
  }

  apply(event: TranscriptEvent): void {
    if (event.generation !== undefined && event.generation !== this.generation) {
      this.resetSession(this.sessionKey);
    }
    switch (event.type) {
      case "turn_start":
        // A turn start is NOT itself a boundary: tool-call-only assistant
        // messages and internal updates live inside the same activity block.
        break;
      case "message_start": {
        const message = event.message;
        if (!message) break;
        if (message.role === "user") this.applyUserBoundary();
        // assistant message_start carries no visible content yet; defer.
        break;
      }
      case "message_update": {
        const message = event.message;
        if (!message || message.role !== "assistant") break;
        // First visible assistant content in this segment closes the group
        // (boundary BEFORE the text) and arms the separator — exactly once.
        if (assistantHasVisibleText(message) && this.lastNode !== "assistant-text") {
          // The line is armed ONLY when real tool activity preceded it in this
          // segment; after a user/barrier boundary a fresh answer gets no line
          // (5.2: no stale state across a user turn).
          const followsTools = this.lastNode === "exploration" || this.lastNode === "other-tool";
          this.closeOpenGroup();
          this.separatorPending = followsTools;
          this.lastNode = "assistant-text";
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (!message) break;
        if (message.role === "assistant" && !assistantHasVisibleText(message)) {
          // Tool-call-only / empty assistant messages are transparent.
          this.lastNode = this.lastNode === "assistant-text" ? "assistant-text" : this.lastNode;
        }
        if (message.role === "user") this.applyUserBoundary();
        break;
      }
      case "tool_execution_start": {
        if (!event.toolCallId || !event.toolName) break;
        const exploration = this.isOwnExploration(event.toolName);
        if (exploration) {
          this.joinOrCreateGroup(event.toolCallId, event.toolName);
          this.lastNode = "exploration";
          this.separatorPending = true; // tools ran; next text gets a line
        } else {
          // Any non-exploration visible tool (bash/edit/write/foreign) is a
          // boundary AND runs its own activity: close group, mark activity.
          this.closeOpenGroup();
          this.lastNode = "other-tool";
          this.separatorPending = true;
        }
        break;
      }
      case "tool_execution_end": {
        if (!event.toolCallId) break;
        const groupId = this.memberOf.get(event.toolCallId);
        if (groupId !== undefined) {
          const group = this.groups.get(groupId);
          const member = group?.members.find((m) => m.toolCallId === event.toolCallId);
          if (member) {
            member.done = true;
            member.isError = event.isError === true;
            member.images = event.imageCount ?? member.images;
            if (member.isError) {
              // A failed member stays visible on its own and ends the group.
              if (group) group.open = false;
              if (this.openGroupId === groupId) this.openGroupId = undefined;
            }
          }
        } else {
          // Result for a tool we never saw start (unknown/foreign/late).
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
    this.separatorPending = false; // user turn resets pending text boundary
  }

  private closeOpenGroup(): void {
    if (this.openGroupId !== undefined) {
      const group = this.groups.get(this.openGroupId);
      if (group) group.open = false;
      this.openGroupId = undefined;
    }
  }

  private isOwnExploration(toolName: string): boolean {
    // Ownership (sourceInfo) is checked by the caller via the adapter; the
    // state machine accepts the canonical names only.
    return EXPLORATION_TOOLS.has(toolName);
  }

  private joinOrCreateGroup(toolCallId: string, toolName: string): void {
    const existing = this.memberOf.get(toolCallId);
    if (existing !== undefined) return; // idempotent duplicate start
    if (this.openGroupId !== undefined) {
      const group = this.groups.get(this.openGroupId)!;
      group.members.push({ toolCallId, toolName, order: group.members.length, isError: false, images: 0, done: false });
      this.memberOf.set(toolCallId, group.id);
      return;
    }
    const id = this.nextGroupId++;
    const group: ExplorationGroup = { id, members: [], open: true };
    group.members.push({ toolCallId, toolName, order: 0, isError: false, images: 0, done: false });
    this.groups.set(id, group);
    this.memberOf.set(toolCallId, id);
    this.openGroupId = id;
  }

  /** Display plan for an exploration member row (or undefined if ungrouped). */
  explorationPlan(toolCallId: string): ExplorationPlan | undefined {
    const groupId = this.memberOf.get(toolCallId);
    if (groupId === undefined) return undefined;
    const group = this.groups.get(groupId);
    if (!group) return undefined;
    const index = group.members.findIndex((m) => m.toolCallId === toolCallId);
    if (index < 0) return undefined;
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
    };
  }

  /** Group lookup for the header title (Explored vs Exploring). */
  groupRunning(toolCallId: string): boolean {
    return this.explorationPlan(toolCallId)?.running ?? false;
  }

  /** Consume the pending separator for a new assistant text segment. */
  takeTextPlan(segmentKeySuffix = ""): TextPlan {
    const key = `seg-${this.generation}-${this.nextSegmentId++}${segmentKeySuffix}`;
    const want = this.separatorPending && this.lastNode !== "barrier";
    this.separatorPending = false;
    this.separatorDone.add(key);
    return { segmentKey: key, separatorBefore: want };
  }

  /** Whether a segment key already took its separator (idempotence queries). */
  separatorAlreadyTaken(key: string): boolean {
    return this.separatorDone.has(key);
  }

  /** Test/inspection helper: group member ids in order. */
  groupMemberIds(groupId: number): string[] {
    return this.groups.get(groupId)?.members.map((m) => m.toolCallId) ?? [];
  }

  /** Open-ness of a member's group (title stays Explored while open). */
  groupOpen(toolCallId: string): boolean {
    const groupId = this.memberOf.get(toolCallId);
    return groupId !== undefined && this.groups.get(groupId)?.open === true;
  }

  static readonly EXPLORATION_TOOLS = EXPLORATION_TOOLS;
  static readonly EXPLORATION_TOOLS_WITH_PATH = EXPLORATION_TOOLS_WITH_PATH;
}
