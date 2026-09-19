export type LanVoiceActivityMessage = {
    type: "activity";
    state: "idle" | "working";
} | {
    type: "activity";
    state: "waiting";
    text?: string;
} | {
    type: "activity";
    state: "settled";
    text: string;
};
export declare class LanVoiceActivity {
    private readonly publish;
    private state;
    constructor(options: {
        initialWorking: boolean;
        publish(message: LanVoiceActivityMessage): void;
    });
    snapshot(): LanVoiceActivityMessage;
    working(): void;
    waiting(text?: string): void;
    settled(text?: string): void;
}
export declare function boundedAssistantText(parts: Array<{
    type: string;
    text?: string | undefined;
}>): string | undefined;
