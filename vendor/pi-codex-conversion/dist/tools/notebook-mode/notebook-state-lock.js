import { acquireDirectoryLock } from "../code-mode/directory-lock.js";
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 5_000;
/**
 * Cross-process lease shared by the notebook state stores (project, profile, npm
 * inventory, session checkpoints): wait briefly for the owner, then release only
 * this owner's file.
 */
export async function withNotebookStateLock(path, operation, signal) {
    const lock = await acquireDirectoryLock(path, {
        waitMs: LOCK_WAIT_MS,
        staleMs: LOCK_STALE_MS,
        pollMs: 50,
        signal,
    });
    if (!lock)
        throw new Error(`Notebook state lock became unavailable: ${path}`);
    try {
        return await operation();
    }
    finally {
        lock.release();
    }
}
