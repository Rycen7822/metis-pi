import { readFile } from "node:fs/promises";
import type { ContextPruneConfig } from "./types.js";
/**
 * Settings location: the active pi agent's main `settings.json` under the
 * `contextPrune` namespace, mirroring pi's own conventions for `compaction`,
 * `retry`, `branchSummary`, etc. Pi's SettingsManager preserves unknown
 * top-level keys when it rewrites settings, so the namespace coexists safely
 * with pi's own settings.
 *
 * Resolved against `getAgentDir()` so it honors `PI_CODING_AGENT_DIR`
 * (defaults to `~/.pi/agent`). Each pi preset directory therefore gets its
 * own context-prune config — including its own summarizer model.
 *
 * Computed lazily on each read/write rather than frozen at module load, so the
 * resolved path always reflects the current `PI_CODING_AGENT_DIR` regardless of
 * when the module was first imported.
 */
export declare function settingsPath(): string;
/** Top-level key under which context-prune state lives in `settings.json`. */
export declare const SETTINGS_KEY: "contextPrune";
export declare class SettingsReadError extends Error {
    readonly path: string;
    readonly reason: string;
    constructor(path: string, reason: string);
}
/**
 * Reads `<agent-dir>/settings.json` and returns the `contextPrune` block, or
 * defaults. Fail-soft: an unreadable or malformed file yields defaults, since
 * a broken settings.json is pi-wide and not this extension's to report.
 */
export declare function loadConfig(): Promise<ContextPruneConfig>;
/**
 * Writes the full config back to `<agent-dir>/settings.json` under
 * {@link SETTINGS_KEY}, preserving every other top-level key in the file.
 * Tmp-file + atomic rename, so a concurrent reader never observes a partial
 * file. A file that cannot be read as a JSON object is never replaced: the
 * read throws {@link SettingsReadError} before anything is written. Concurrent
 * saves (ours or pi's own) are last-write-wins; that race is not coordinated.
 */
export declare function saveConfig(config: ContextPruneConfig, read?: typeof readFile): Promise<void>;
type Notify = (message: string, type?: "info" | "warning" | "error") => void;
/**
 * Saves and reports failure through `notify` instead of rejecting, so callers
 * can fire-and-forget. The in-memory change stands; only persistence failed.
 */
export declare function persistConfig(notify: Notify, config: ContextPruneConfig, save?: (config: ContextPruneConfig) => Promise<void>): Promise<void>;
export {};
