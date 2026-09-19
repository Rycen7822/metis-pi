import { type NotebookCheckpointIdentity } from "./checkpoint.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { type ProjectStateBaseline } from "./project-state.ts";
import { type ProjectStatePinUpdate } from "./project-state-merge.ts";
export declare class NotebookCheckpointManager {
    private readonly maxBytes;
    private readonly currentKernel;
    private readonly runningCellId;
    private readonly reportNotice;
    private baselineNames;
    private identity;
    private projectBaseline;
    private timer;
    private dirty;
    private maintenance;
    private lastCheckpointAt;
    constructor(options: {
        maxBytes: number;
        currentKernel(): DenoJupyterKernel | undefined;
        runningCellId(): string | undefined;
        reportNotice(notice: string, showInUi: boolean): void;
    });
    configure(identity: NotebookCheckpointIdentity, baselineNames: Set<string>, projectBaseline: ProjectStateBaseline): void;
    schedule(): void;
    flush(options?: {
        requireIdle?: boolean | undefined;
        force?: boolean | undefined;
        excludeNames?: ReadonlySet<string> | undefined;
        pins?: ProjectStatePinUpdate | undefined;
    }): Promise<void>;
    reset(): void;
    discard(): Promise<void>;
    status(): {
        dirty: boolean;
        projectGeneration: string;
        projectBindings: number;
        lastCheckpointAt?: string | undefined;
    };
    private perform;
}
