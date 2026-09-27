import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
export interface ThenRunInput {
    command: string;
    timeout?: number;
}
export declare const THEN_RUN_SCHEMA: Type.TOptional<Type.TObject<{
    command: Type.TString;
    timeout: Type.TOptional<Type.TNumber>;
}>>;
export interface FusionCommandResult {
    status: "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "skipped";
    output: string;
    exitCode?: number | undefined;
    error?: string | undefined;
    fullOutputPath?: string | undefined;
    fullOutputBytes?: number | undefined;
    fullOutputComplete?: boolean | undefined;
    fullOutputAppendOnly?: boolean | undefined;
    fullOutputError?: string | undefined;
}
export interface FusionReceipt {
    version: 1;
    mutationStatus: "success" | "failed" | "partial_failure";
    command: Omit<FusionCommandResult, "output"> & {
        command: string;
        outputBlock: number;
    };
}
export type FusionResult = AgentToolResult<Record<string, unknown> & {
    metisActionFusion?: FusionReceipt;
}>;
export type FusionCommandRunner = (input: ThenRunInput, signal?: AbortSignal, update?: (result: FusionCommandResult) => void) => Promise<FusionCommandResult>;
export declare function validateThenRun(input: unknown): ThenRunInput | undefined;
export declare function fusionReceipt(details: unknown): FusionReceipt | undefined;
export declare function fusionFailed(details: unknown): boolean;
export declare function executeFusion(options: {
    paths: string[];
    thenRun?: unknown;
    signal?: AbortSignal | undefined;
    mutate(): Promise<AgentToolResult<unknown>>;
    run: FusionCommandRunner;
    onUpdate?: ((result: FusionResult) => void) | undefined;
}): Promise<AgentToolResult<unknown>>;
