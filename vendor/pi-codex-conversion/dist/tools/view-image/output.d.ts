export type ViewImageContent = {
    type: "image";
    data: string;
    mimeType: string;
    detail: "high" | "original";
};
export declare function imageContentsFromViewImageDetails(details: unknown): ViewImageContent[];
export declare function imageContentFromViewImageOutput(output: string): ViewImageContent | undefined;
export declare function imageContentsFromViewImageOutput(output: string): ViewImageContent[];
