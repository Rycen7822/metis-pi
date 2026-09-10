import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { installTranscriptDecorations, type DecorationHandle } from "./transcript-adapter.ts";
import { TranscriptState, type TranscriptEvent } from "./transcript-state.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory, type ShellFactories } from "./renderers.ts";
import { WriteDiffTracker, resolveWritePath, type WriteDiff } from "./write-tracker.ts";
import { detectColorLevel, type ColorLevel } from "./palette.ts";

export interface AppearanceAPI {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: {
    hasUI: boolean; ui: { notify(text: string, level: "warning"): void };
  }) => void): void;
  on(event: "tool_execution_start", handler: (event: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }, context: { cwd: string }) => void): void;
  on(event: "tool_execution_end", handler: (event: { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }, context: { cwd: string }) => void): void;
  on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  getAllTools(): readonly unknown[];
}
export interface Bindings {
  prototype: object;
  makeText: TextFactory;
  expandHint(): string;
  highlight?: Highlight;
  makeDiff?: DiffFactory;
  makeShell?: ShellFactories;
  /** Pipeline color capability resolved from the live terminal (host-provided). */
  colorLevel?: ColorLevel;
  /** Real terminal layout ops (wrap/width) for fallback text paths. */
  layoutOps?: import("./tool-names.ts").DiffLayoutOps;
  /** Pi AssistantMessageComponent prototype (separator decoration target). */
  assistantPrototype?: object;
  /** Build a width-aware separator component (host TUI Text). */
  makeSeparator?: () => unknown;
  /** Build a 1-row spacer component (host TUI Spacer). */
  makeSpacer?: () => unknown;
  /** Wrap a thinking display node with our rail (host TUI primitives). */
  makeRail?: (child: unknown) => unknown;
  /** Detect an external owner that already renders thinking rails. */
  externalRailOwner?: () => boolean;
  /** Build the live write-args preview component (host TUI primitives). */
  makeWritePreview?: import("./renderers.ts").WritePreviewInput extends infer T
    ? (input: T) => import("./tool-names.ts").Component | undefined
    : never;
}

/** Session-scoped presentation state (ephemeral, display-only). */
export interface AppearanceSession {
  tracker: WriteDiffTracker;
  colorLevel: ColorLevel;
  /** Completed write diffs keyed by toolCallId; entries are pruned on read. */
  readonly writeChanges: Map<string, WriteDiff>;
  /** Display-order projection (exploration groups + text boundaries). */
  readonly transcript: TranscriptState;
  /** toolCallId → image-block count from the REAL result content. */
  readonly resultImages: Map<string, number>;
}

/** Bounded store for completed write diffs (entry + total budget). */
const MAX_WRITE_CHANGES = 64;
const MAX_IMAGE_ENTRIES = 256;

/** Extract image-block count from a tool result WITHOUT copying payloads. */
function countImageBlocks(result: unknown): number {
  try {
    const content = (result as Record<string, unknown> | null)?.content;
    if (!Array.isArray(content)) return 0;
    return content.filter((block) => (block as Record<string, unknown>)?.type === "image").length;
  } catch {
    return 0;
  }
}

/** Normalize a host message into the state machine's read-only shape. */
function toStateMessage(message: unknown): TranscriptEvent["message"] {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (!role) return undefined;
  const content = Array.isArray(record.content)
    ? (record.content as unknown[]).map((block) => {
        const b = (block ?? {}) as Record<string, unknown>;
        return { type: String(b.type ?? ""), text: typeof b.text === "string" ? b.text : undefined, thinking: typeof b.thinking === "string" ? b.thinking : undefined };
      })
    : [];
  return {
    role,
    content,
    stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
  };
}

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
  let handle: AdapterHandle | undefined;
  let decorations: DecorationHandle | undefined;
  const transcript = new TranscriptState();
  const session: AppearanceSession = {
    tracker: new WriteDiffTracker(),
    colorLevel: bindings.colorLevel ?? detectColorLevel(),
    writeChanges: new Map<string, WriteDiff>(),
    transcript,
    resultImages: new Map<string, number>(),
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = ctx.hasUI;
    if (!enabled || handle?.installed) return;
    handle = installAdapter(bindings.prototype, {
      getTools: () => pi.getAllTools(), enabled: () => enabled,
      renderers: makeRenderers(bindings.makeText, bindings.expandHint, bindings.highlight, bindings.makeDiff, bindings.makeShell, bindings.makeWritePreview, session, bindings.layoutOps),
    });
    if (!handle.installed) ctx.ui.notify(`pi-codex-appearance: ${handle.reason}. Compact transcript was not installed.`, "warning");
    // Scoped transcript decorations (member spacing + assistant separator +
    // thinking rail). Failures are reported PER FEATURE; per-member rows,
    // native text and the output dimming keep working regardless.
    if (bindings.assistantPrototype && bindings.makeSeparator) {
      decorations = installTranscriptDecorations({
        state: transcript,
        toolPrototype: bindings.prototype,
        assistantPrototype: bindings.assistantPrototype,
        makeSeparator: bindings.makeSeparator,
        makeSpacer: bindings.makeSpacer ?? (() => undefined),
        makeRail: bindings.makeRail,
        externalRailOwner: bindings.externalRailOwner,
        enabled: () => enabled,
      });
      const failedFeatures = decorations.features.filter((f) => !f.installed);
      if (failedFeatures.length) {
        const detail = failedFeatures.map((f) => `${f.name}: ${f.reason}`).join("; ");
        ctx.ui.notify(`pi-codex-appearance: decorations partially unavailable (${detail}).`, "warning");
      }
    }
  });

  /** Look up a tool entry's sourceInfo (exact builtin ownership checks). */
  function sourceInfoFor(toolName: string): unknown {
    try {
      const entry = pi.getAllTools().find((tool) =>
        tool !== null && typeof tool === "object" && (tool as Record<string, unknown>).name === toolName);
      return entry ? (entry as Record<string, unknown>).sourceInfo : undefined;
    } catch {
      return undefined;
    }
  }

  /** Exact builtin ownership (same rule as adapter.ts replacement()). */
  function ownsBuiltin(toolName: string): boolean {
    const source = sourceInfoFor(toolName) as Record<string, unknown> | undefined;
    return source?.source === "builtin" && source?.path === `<builtin:${toolName}>`;
  }

  // Write tracking observes lifecycle events only (never tool_call/tool_result
  // content). Reads the local file for an honest pre/post image; all state is
  // ephemeral presentation data dropped at session shutdown.
  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled) return;
    const info = sourceInfoFor(event.toolName);
    session.tracker.trackStart(event.toolCallId, event.toolName, event.args, info, (path) => resolveWritePath(path, ctx.cwd));
    // Transcript projection: exploration grouping + separator boundary.
    transcript.apply({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName });
  });
  pi.on("tool_execution_end", (event) => {
    if (!enabled) return;
    const info = sourceInfoFor(event.toolName);
    const change = session.tracker.trackEnd(event.toolCallId, event.toolName, info, event.isError);
    if (change) {
      session.writeChanges.set(event.toolCallId, change);
      if (session.writeChanges.size > MAX_WRITE_CHANGES) {
        const oldest = session.writeChanges.keys().next().value;
        if (oldest !== undefined) session.writeChanges.delete(oldest);
      }
    }
    // Image count from the real result content blocks (count only, no copy).
    const images = countImageBlocks(event.result);
    if (images > 0) {
      session.resultImages.set(event.toolCallId, images);
      if (session.resultImages.size > MAX_IMAGE_ENTRIES) {
        const oldest = session.resultImages.keys().next().value;
        if (oldest !== undefined) session.resultImages.delete(oldest);
      }
    }
    transcript.apply({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError === true, imageCount: images });
  });
  // Wire the real message handlers (typed loosely above to avoid importing
  // host event types; only read-only content-shape fields are read).
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_start", (event) => {
    if (!enabled) return;
    transcript.apply({ type: "message_start", message: toStateMessage(event.message) });
  });
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_update", (event) => {
    if (!enabled) return;
    transcript.apply({ type: "message_update", message: toStateMessage(event.message) });
  });
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_end", (event) => {
    if (!enabled) return;
    transcript.apply({ type: "message_end", message: toStateMessage(event.message) });
  });
  pi.on("session_shutdown", () => {
    enabled = false;
    handle?.dispose();
    handle = undefined;
    decorations?.dispose();
    decorations = undefined;
    session.writeChanges.clear();
    session.resultImages.clear();
    transcript.resetSession();
  });
}
