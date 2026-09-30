import type { ExecutionConfig } from "./config.ts";
import type { ExecSessionManager } from "./exec/session-manager.ts";
export interface ExecutionRuntime { config: ExecutionConfig; sessions: ExecSessionManager; }
