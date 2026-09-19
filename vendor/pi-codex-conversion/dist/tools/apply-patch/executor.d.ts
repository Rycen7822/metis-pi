import { type ExecutePatchResult } from "../../patch/types.ts";
export declare function executePatchWithRust({ cwd, patchText, signal, customRustBinariesDir }: {
    cwd: string;
    patchText: string;
    signal?: AbortSignal | undefined;
    customRustBinariesDir?: string | undefined;
}): Promise<ExecutePatchResult>;
