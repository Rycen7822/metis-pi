export interface LanVoiceDraftSelection {
    start: number;
    end: number;
}
export declare class LanVoiceDraftError extends Error {
}
export declare class LanVoiceDraftConflictError extends LanVoiceDraftError {
}
export declare class LanVoiceDraft {
    private readonly publish;
    private readonly sendMessage;
    private text;
    private revision;
    constructor(options: {
        publish(message: unknown): void;
        sendMessage(text: string): void;
    });
    snapshot(sourceClientId?: string, reason?: "update" | "transcript" | "sent"): {
        type: "draft";
        text: string;
        revision: number;
        sourceClientId?: string;
        reason?: string;
    };
    update(clientId: string, value: unknown, expectedRevision: unknown): number;
    insertTranscript(clientId: string, transcript: string, selection?: LanVoiceDraftSelection): void;
    send(clientId: string, value: unknown, expectedRevision: unknown): void;
    private assertRevision;
}
