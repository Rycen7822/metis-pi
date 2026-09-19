import type { RuntimeContentItem } from "../code-mode/types.ts";
import type { KernelExecutionResult } from "./jupyter-kernel.ts";
export interface NotebookJournal {
    path: string;
    eventsPath: string;
    project: string;
    session: string;
    cells: number;
    completedCells: number;
    writable: boolean;
    maxBytes: number;
}
export interface NotebookJournalCodeCell {
    id: string;
    index: number;
    source: string;
}
export declare function initializeNotebookJournal(identity: {
    project: string;
    session: string;
    agentDir: string;
}, maxBytes: number): NotebookJournal;
export declare function beginNotebookJournalCell(journal: NotebookJournal, cell: {
    id: string;
    source: string;
}): void;
export declare function finishNotebookJournalCell(journal: NotebookJournal, cell: {
    id: string;
    source: string;
    items: RuntimeContentItem[];
    result: KernelExecutionResult;
}): void;
export declare function materializeNotebookJournal(journal: NotebookJournal): void;
export declare function readNotebookJournalCodeCells(path: string): NotebookJournalCodeCell[];
