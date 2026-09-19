export type NotebookRuntimeHealthState = "not_started" | "ready" | "invalidated";
export interface NotebookRuntimeHealth {
    state: NotebookRuntimeHealthState;
}
export declare const NOTEBOOK_INTERRUPTED_NOTICE = "Notebook runtime was invalidated by an interrupted cell. The next operation will recreate it from the last completed checkpoint; durable project bindings were preserved. External side effects were not rolled back";
export declare const NOTEBOOK_BOOTSTRAP_NOTICE = "Notebook runtime bootstrap was unavailable. The kernel was discarded; the next operation will recreate it from the last completed checkpoint. Durable project bindings were preserved";
export declare const NOTEBOOK_KERNEL_FAILURE_NOTICE = "Notebook runtime became unavailable during a host operation. The next operation will recreate it from the last completed checkpoint; durable project bindings were preserved. External side effects were not rolled back";
export declare function isNotebookBootstrapFailure(value: unknown): boolean;
