import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecSessionManager } from "./session-manager.ts";
export declare function createWriteStdinTool(sessions: ExecSessionManager, options?: {
    promptSnippet?: boolean | undefined;
    showOutputWhenCollapsed?: boolean | undefined;
}): import("@earendil-works/pi-coding-agent").ToolDefinition<Type.TSchema, unknown, unknown>;
export declare function registerWriteStdinTool(pi: ExtensionAPI, sessions: ExecSessionManager, options?: {
    promptSnippet?: boolean | undefined;
    showOutputWhenCollapsed?: boolean | undefined;
}): void;
