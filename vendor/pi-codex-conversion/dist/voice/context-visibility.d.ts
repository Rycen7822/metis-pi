type ContextMessage = {
    role: string;
    customType?: string | undefined;
    content?: unknown;
};
export declare function isVoiceContextExcludedMessage(message: ContextMessage): boolean;
export {};
