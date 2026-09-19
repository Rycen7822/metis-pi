import { type ShellAction } from "../../shell/summary.ts";
export type ExecCommandStatus = "running" | "done";
export interface ExecCommandRenderInfo {
    hidden: boolean;
    status: ExecCommandStatus;
    actionGroups?: ShellAction[][] | undefined;
    commands?: string[] | undefined;
}
export interface ExecCommandTracker {
    getState(command: string): ExecCommandStatus;
    getRenderInfo(toolCallId: string | undefined, command: string): ExecCommandRenderInfo;
    registerRenderContext(toolCallId: string | undefined, invalidate: () => void): void;
    recordStart(toolCallId: string, command: string): void;
    recordPersistentSession(toolCallId: string, sessionId: number): void;
    recordEnd(toolCallId: string): void;
    recordSessionFinished(sessionId: number): void;
    resetExplorationGroup(): void;
    clear(): void;
}
export declare function createExecCommandTracker(): ExecCommandTracker;
