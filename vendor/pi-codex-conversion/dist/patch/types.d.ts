export type ActionType = "add" | "delete" | "update";
export interface Chunk {
    origIndex: number;
    delLines: string[];
    insLines: string[];
}
export interface PatchAction {
    type: ActionType;
    newFile?: string | undefined;
    chunks: Chunk[];
    movePath?: string | undefined;
}
export interface ParsedPatchAction {
    type: ActionType;
    path: string;
    newFile?: string | undefined;
    lines?: string[] | undefined;
    movePath?: string | undefined;
}
export interface ParserState {
    lines: string[];
    index: number;
    fuzz: number;
}
export interface ExecutePatchResult {
    changedFiles: string[];
    createdFiles: string[];
    deletedFiles: string[];
    movedFiles: string[];
    fuzz: number;
}
export interface ExecutePatchFailure {
    action: ParsedPatchAction;
    message: string;
}
export declare class DiffError extends Error {
    constructor(message: string);
}
export declare class ExecutePatchError extends DiffError {
    result: ExecutePatchResult;
    failedAction?: ParsedPatchAction | undefined;
    failures: ExecutePatchFailure[];
    constructor(message: string, result: ExecutePatchResult, failures?: ExecutePatchFailure[]);
    hasPartialSuccess(): boolean;
}
