import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory, type ShellFactories } from "./renderers.ts";
import { WriteDiffTracker, resolveWritePath, type WriteDiff } from "./write-tracker.ts";
import { detectColorLevel, type ColorLevel } from "./palette.ts";

export interface AppearanceAPI {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: {
    hasUI: boolean; ui: { notify(text: string, level: "warning"): void };
  }) => void): void;
  on(event: "tool_execution_start", handler: (event: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }, context: { cwd: string }) => void): void;
  on(event: "tool_execution_end", handler: (event: { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }, context: { cwd: string }) => void): void;
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
}

/** Session-scoped presentation state (ephemeral, display-only). */
export interface AppearanceSession {
  tracker: WriteDiffTracker;
  colorLevel: ColorLevel;
  /** Completed write diffs keyed by toolCallId; entries are pruned on read. */
  readonly writeChanges: Map<string, WriteDiff>;
}

/** Bounded store for completed write diffs (entry + total budget). */
const MAX_WRITE_CHANGES = 64;

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
  let handle: AdapterHandle | undefined;
  const session: AppearanceSession = {
    tracker: new WriteDiffTracker(),
    colorLevel: bindings.colorLevel ?? detectColorLevel(),
    writeChanges: new Map<string, WriteDiff>(),
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = ctx.hasUI;
    if (!enabled || handle?.installed) return;
    handle = installAdapter(bindings.prototype, {
      getTools: () => pi.getAllTools(), enabled: () => enabled,
      renderers: makeRenderers(bindings.makeText, bindings.expandHint, bindings.highlight, bindings.makeDiff, bindings.makeShell, session, bindings.layoutOps),
    });
    if (!handle.installed) ctx.ui.notify(`pi-codex-appearance: ${handle.reason}. Compact transcript was not installed.`, "warning");
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

  // Write tracking observes lifecycle events only (never tool_call/tool_result
  // content). Reads the local file for an honest pre/post image; all state is
  // ephemeral presentation data dropped at session shutdown.
  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled) return;
    const info = sourceInfoFor(event.toolName);
    session.tracker.trackStart(event.toolCallId, event.toolName, event.args, info, (path) => resolveWritePath(path, ctx.cwd));
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
  });
  pi.on("session_shutdown", () => {
    enabled = false;
    handle?.dispose();
    handle = undefined;
    session.writeChanges.clear();
  });
}
