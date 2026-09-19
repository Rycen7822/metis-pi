import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecCommandTracker } from "./command-state.ts";
import type { ExecSessionManager } from "./session-manager.ts";
interface ExecCommandToolOptions {
    customRendering?: boolean | undefined;
    promptSnippet?: boolean | undefined;
    showOutputWhenCollapsed?: boolean | undefined;
    waitForNonInteractiveExit?: boolean | undefined;
}
export declare function createExecCommandTool(tracker: ExecCommandTracker, sessions: ExecSessionManager, options?: ExecCommandToolOptions): import("@earendil-works/pi-coding-agent").ToolDefinition<Type.TSchema, unknown, unknown>;
export declare function registerExecCommandTool(pi: ExtensionAPI, tracker: ExecCommandTracker, sessions: ExecSessionManager, options?: ExecCommandToolOptions): void;
export {};
