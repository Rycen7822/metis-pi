import type { Component } from "@earendil-works/pi-tui";
import type { RuntimeToolTrace } from "./types.js";
export interface NestedRenderState {
    state: Record<string, unknown>;
    callComponent?: Component | undefined;
    resultComponent?: Component | undefined;
    input?: unknown;
    result?: RuntimeToolTrace["result"];
}
export declare class CodeModeNestedRenderStore {
    private readonly states;
    private readonly weights;
    private retainedBytes;
    private readonly maxBytes;
    constructor(maxBytes?: number);
    get(traceId: string): NestedRenderState;
    captureInput(traceId: string, input: unknown): void;
    captureResult(traceId: string, result: NonNullable<RuntimeToolTrace["result"]>): void;
    rebalance(traceId: string): void;
    clear(): void;
    private delete;
    private trim;
}
