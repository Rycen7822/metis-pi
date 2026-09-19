export const NOTEBOOK_EXEC_ACTIONS = ["status", "list", "diagnostics"];
export function canExecuteNotebookControlInsideExec(request) {
    return NOTEBOOK_EXEC_ACTIONS.includes(request.action)
        && (request.action !== "status" || request.query === undefined);
}
export function notebookExecStartupNotice() {
    return `Inside exec tools.notebook supports ${NOTEBOOK_EXEC_ACTIONS.join(", ")}; all others use the top-level notebook tool after exec returns`;
}
