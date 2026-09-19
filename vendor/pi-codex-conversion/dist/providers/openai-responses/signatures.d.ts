export type TextSignaturePhase = "commentary" | "final_answer";
export declare function shortHash(str: string): string;
export declare function encodeTextSignatureV1(id: string, phase?: string): string;
export declare function parseTextSignature(signature: string | undefined): {
    id: string;
    phase?: TextSignaturePhase | undefined;
} | undefined;
