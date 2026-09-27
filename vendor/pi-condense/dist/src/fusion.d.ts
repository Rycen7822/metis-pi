import type { CapturedToolCall } from "./types.js";
/** Structural versioned boundary; never infer execution success from log text. */
export declare function captureFusionResult(result: any): Partial<CapturedToolCall>;
export declare function captureFusionJournal(result: any): Partial<CapturedToolCall>;
