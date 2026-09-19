import type { RuntimeContentItem } from "../code-mode/types.ts";
import type { JupyterMessage } from "./jupyter-wire.ts";
export interface KernelExecutionResult {
    status: "ok" | "error" | "aborted";
    items: RuntimeContentItem[];
    errorText?: string | undefined;
    errorName?: string | undefined;
    errorValue?: string | undefined;
}
export interface ActiveKernelExecution {
    requestId: string;
    items: RuntimeContentItem[];
    outputChars: number;
    outputTruncated: boolean;
    status: KernelExecutionResult["status"];
    errorText?: string | undefined;
    errorName?: string | undefined;
    errorValue?: string | undefined;
    onOutput?: ((item: RuntimeContentItem) => void) | undefined;
    resolve(result: KernelExecutionResult): void;
    reject(error: Error): void;
}
export declare function applyKernelOutput(message: JupyterMessage, execution: ActiveKernelExecution): "idle" | undefined;
export declare function finishKernelExecution(execution: ActiveKernelExecution): KernelExecutionResult;
export declare function applyExecuteReplyError(result: KernelExecutionResult, reply: JupyterMessage): KernelExecutionResult;
