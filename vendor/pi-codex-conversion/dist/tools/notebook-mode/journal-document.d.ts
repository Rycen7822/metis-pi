export interface NotebookDocument {
    cells: NotebookCell[];
    metadata: Record<string, unknown>;
    nbformat: number;
    nbformat_minor: number;
}
export interface NotebookCell {
    id: string;
    cell_type: string;
    execution_count?: number | null | undefined;
    metadata: Record<string, unknown>;
    outputs?: Array<Record<string, unknown>> | undefined;
    source: string[] | string;
}
export type NotebookJournalEvent = {
    type: "begin";
    id: string;
    source: string;
    createdAt: string;
} | {
    type: "finish";
    id: string;
    source: string;
    status: string;
    completedAt: string;
    outputs: Array<Record<string, unknown>>;
};
export declare function emptyNotebookDocument(project: string, session: string): NotebookDocument;
export declare function applyNotebookJournalEvent(document: NotebookDocument, event: NotebookJournalEvent): void;
export declare function readNotebookDocument(path: string, maxBytes?: number): NotebookDocument | undefined;
export declare function writeNotebookDocument(path: string, document: NotebookDocument, maxBytes?: number): void;
export declare function notebookCellId(cell: NotebookCell): string | undefined;
export declare function notebookCellStatus(cell: NotebookCell): string | undefined;
