export interface RealtimeVoiceTurn {
    input: string;
    transcriptDelta?: string;
    delegationId?: string;
}
export interface TrackedRealtimeDelegation {
    turn: RealtimeVoiceTurn;
    displayInput: boolean;
}
/** Keeps conversational display turns separate from V3 delegation handoffs. */
export declare class RealtimeVoiceTurnTracker {
    private readonly transcript;
    private pendingUserInputs;
    private recentlyAnsweredUserInput;
    private unfinishedUserTurns;
    private activeUserTurn;
    private delegatedUserFinishes;
    private readonly delegationIds;
    private readonly outstandingDelegations;
    private readonly outstandingInputs;
    get hasPendingInput(): boolean;
    inputAdded(input: string): void;
    outputAdded(output: string): void;
    userFinished(input: string): boolean;
    delegated(input: string, delegationId: string): TrackedRealtimeDelegation | undefined;
    delegationSettled(delegationId: string): void;
    assistantFinished(output?: string): RealtimeVoiceTurn | undefined;
    takeTranscriptTail(): string | undefined;
    drainConversationTurns(): RealtimeVoiceTurn[];
    reset(): void;
    private finishDelegation;
}
