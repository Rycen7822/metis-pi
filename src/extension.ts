import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory } from "./renderers.ts";
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
  makeShell?: import("./renderers.ts").ShellFactory;
}

/** Session-scoped presentation state (ephemeral, display-only). */
export interface AppearanceSession {
  tracker: WriteDiffTracker;
  colorLevel: ColorLevel;
  /** Completed write diffs keyed by toolCallId; entries are pruned on read. */
  readonly writeChanges: Map<string, WriteDiff>;
}

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
  let handle: AdapterHandle | undefined;
  const session: AppearanceSession = {
    tracker: new WriteDiffTracker(),
    colorLevel: detectColorLevel(),
    writeChanges: new Map<string, WriteDiff>(),
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = ctx.hasUI;
    if (!enabled || handle?.installed) return;
    handle = installAdapter(bindings.prototype, {
      getTools: () => pi.getAllTools(), enabled: () => enabled,
      renderers: makeRenderers(bindings.makeText, bindings.expandHint, bindings.highlight, bindings.makeDiff, bindings.makeShell, session),
    });
    if (!handle.installed) ctx.ui.notify(`pi-codex-appearance: ${handle.reason}. Compact transcript was not installed.`, "warning");
  });
  // Write tracking observes lifecycle events only (never tool_call/tool_result
  // content). Reads the local file for an honest pre/post image; all state is
  // ephemeral presentation data dropped at session shutdown.
  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled) return;
    session.tracker.trackStart(event.toolCallId, event.toolName, event.args, (path) => resolveWritePath(path, ctx.cwd));
  });
  pi.on("tool_execution_end", (event) => {
    if (!enabled) return;
    const change = session.tracker.trackEnd(event.toolCallId, event.toolName, event.isError);
    if (change) {
      session.writeChanges.set(event.toolCallId, change);
      if (session.writeChanges.size > WriteDiffTracker.MAX_PENDING) {
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
