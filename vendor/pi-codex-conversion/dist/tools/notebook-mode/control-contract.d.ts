export declare const NOTEBOOK_EXEC_ACTIONS: readonly ["status", "list", "diagnostics"];
export declare function canExecuteNotebookControlInsideExec(request: {
    action: string;
    query?: string | undefined;
}): boolean;
export declare function notebookExecStartupNotice(): string;
