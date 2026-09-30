import type { ExecutionConfig } from "./config.ts";
import type { ExecSessionManager } from "./exec/session-manager.ts";
import type { ExecCommandTracker } from "./exec/command-state.ts";
export interface ExecutionRuntime { config: ExecutionConfig; sessions: ExecSessionManager; tracker: ExecCommandTracker; }
