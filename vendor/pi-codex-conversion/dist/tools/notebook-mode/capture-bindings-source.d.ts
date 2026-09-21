export declare function captureBindingsSource(options: {
    candidates: string[];
    payloadPath: string;
    maxBytes: number;
    skippedInvalid?: Array<{
        name: string;
        reason: string;
    }> | undefined;
}, scope: "checkpoint" | "project"): string;
