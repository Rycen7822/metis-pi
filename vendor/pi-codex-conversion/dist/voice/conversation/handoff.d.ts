export type RealtimeHandoffChannel = "commentary" | "speakable";
export type RealtimePiInputBehavior = "steer" | "followUp";
export type RealtimeHandoffTarget = {
    type: "delegation";
    id: string;
} | {
    type: "session";
};
interface RealtimeDelegationHandoffCallbacks {
    isActive(): boolean;
    onContext(target: RealtimeHandoffTarget, channel: RealtimeHandoffChannel, content: string): void;
    onSettled(id: string): void;
}
/** Routes one Pi turn back into the active realtime conversation. */
export declare class RealtimeDelegationHandoff {
    private readonly callbacks;
    private target;
    private buffer;
    private streamedProgress;
    private readonly queuedSteers;
    private readonly queuedFollowUps;
    constructor(callbacks: RealtimeDelegationHandoffCallbacks);
    activate(id: string): void;
    piInput(input: unknown, streamingBehavior?: RealtimePiInputBehavior): boolean;
    piUserMessage(message: unknown): boolean;
    private routePiInput;
    stream(delta: string): void;
    progress(content: string): void;
    result(content: string): void;
    settle(): void;
    clear(): void;
    private finishProgress;
    private finishResult;
    private clearQueuedInputs;
    private settleDelegation;
}
export {};
