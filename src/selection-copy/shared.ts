// Shared host-primitive contract for the selection-copy adapters. All
// functions are injected from index.ts so src/ keeps its no-host-import rule.

export type { SerializeHostFns } from "./serialize.ts";

export interface AdapterHostFns {
  visibleWidth(text: string): number;
  sliceByColumn(line: string, start: number, width: number, preserveAnsi: boolean): string;
  stripTerminalSequences(line: string): string;
  stripAnsi(line: string): string;
}
