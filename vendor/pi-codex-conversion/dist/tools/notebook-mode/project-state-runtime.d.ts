import { type ProjectStateManifest } from "./project-state-format.ts";
import type { KernelExecutionResult } from "./jupyter-kernel.ts";
export declare function projectBindingNamesSource(marker: string): string;
export declare function parseProjectBindingNames(result: KernelExecutionResult, marker: string): string[];
export declare function promoteProjectBindingsSource(names: string[]): string;
export declare function syncProjectBindingsSource(names: string[]): string;
export declare function projectStateCaptureSource(options: {
    candidates: string[];
    payloadPath: string;
    manifestPath: string;
    maxBytes: number;
}): string;
export declare function projectStateRestoreSource(manifest: Pick<ProjectStateManifest, "deno" | "v8" | "entries">, payloadPath: string, clearNames?: string[]): string;
