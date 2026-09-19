import type { NotebookControlResult } from "../code-mode/types.ts";
import type { NotebookRuntimeHealthState } from "./runtime-health.ts";
export interface NotebookDiagnostic {
    cellId: string;
    cellIndex: number;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: "error" | "warning" | "information" | "hint" | "unknown";
    code?: string | number | undefined;
    source?: string | undefined;
    name?: string | undefined;
    message: string;
}
export interface NotebookDiagnosticGroup {
    count: number;
    severity: NotebookDiagnostic["severity"];
    code?: string | number | undefined;
    source?: string | undefined;
    name?: string | undefined;
    message: string;
    samples: Array<Pick<NotebookDiagnostic, "cellId" | "cellIndex" | "line" | "column" | "endLine" | "endColumn">>;
}
export declare function diagnoseNotebook(options: {
    deno: string;
    cwd: string;
    path: string;
    runtimeBindings?: ReadonlySet<string> | undefined;
    runtimeHealth?: NotebookRuntimeHealthState | undefined;
    signal?: AbortSignal | undefined;
}): Promise<NotebookControlResult>;
export declare function formatNotebookDiagnostics(path: string, cells: number, diagnostics: NotebookDiagnostic[], runtimeHealth?: NotebookRuntimeHealthState): NotebookControlResult;
