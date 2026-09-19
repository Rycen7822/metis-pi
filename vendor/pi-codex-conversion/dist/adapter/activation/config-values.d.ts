import type { VoiceContextModel } from "./config-contract.ts";
export declare function isObject(value: unknown): value is Record<string, unknown>;
export declare function normalizeBoolean(value: unknown, fallback: boolean): boolean;
export declare function normalizeString(value: unknown, fallback: string): string;
export declare function normalizeOptionalString(value: unknown): string | undefined;
export declare function normalizeIntegerInRange(value: unknown, fallback: number, minimum: number, maximum: number): number;
export declare function normalizeVoiceContextModel(value: unknown): VoiceContextModel | undefined;
export declare function normalizeNotebookProfile(value: unknown): string | undefined;
