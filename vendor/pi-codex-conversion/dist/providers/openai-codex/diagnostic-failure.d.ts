import type { CodexDiagnosticsFailure, CodexDiagnosticsSink } from "./types.ts";
export declare function codexDiagnosticsFailure(error: unknown): CodexDiagnosticsFailure;
export declare function noThrowCodexDiagnosticsSink(sink: CodexDiagnosticsSink | undefined): CodexDiagnosticsSink | undefined;
