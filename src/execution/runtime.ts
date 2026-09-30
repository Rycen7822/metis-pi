import type { createAutoReasoning } from "./auto-reasoning.ts";
import type { ExecutionConfig } from "./config.ts";
import type { ExecSessionManager } from "./exec/session-manager.ts";
import type { ExecCommandTracker } from "./exec/command-state.ts";
export interface ExecutionRuntime { reasoning?: ReturnType<typeof createAutoReasoning>["tool"] | undefined; config: ExecutionConfig; sessions: ExecSessionManager; tracker: ExecCommandTracker; }
