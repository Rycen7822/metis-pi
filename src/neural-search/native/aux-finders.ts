import path from "node:path";
import type { FileFinderApi } from "./binding/api.ts";
import type { FilePickerFactory } from "./file-picker.ts";
import { coversHomeDir, scanOptOutReason } from "./paths.ts";

export const MAX_AUX = 3;
export const IDLE_TTL_MS = 5 * 60 * 1000;
interface Entry { root: string; promise: Promise<FileFinderApi>; finder?: FileFinderApi; users: number; lastUsed: number; }
export interface FinderLease { finder: FileFinderApi; root: string; release(): void; }

/** One record owns an index from initialization through its final lease. */
export class AuxFinderPool {
  private readonly entries = new Map<string, Entry>();
  private readonly controller = new AbortController();
  private eviction?: { timer: ReturnType<typeof setTimeout>; deadline: number };
  constructor(private readonly options: {
    pickers: FilePickerFactory;
    enableFsRootScanning: boolean;
    enableHomeDirScanning: boolean;
    onHomeDirScan?: (root: string) => void;
  }) {}

  async acquire(root: string): Promise<FinderLease> {
    if (this.controller.signal.aborted) throw new Error("Neural-search auxiliary index pool is closed.");
    root = path.resolve(root);
    const refusal = scanOptOutReason(root, this.options);
    if (refusal) throw new Error(refusal);
    this.sweep();
    // Hidden/ignore rules depend on the scan root. An ancestor index cannot
    // attest coverage of this root even when it physically contains it.
    let entry = this.entries.get(root);
    if (!entry) {
      const created: Entry = { root, users: 0, lastUsed: Date.now(),
        promise: Promise.resolve().then(() => this.create(created)).catch(error => { this.remove(created); throw error; }),
      };
      this.entries.set(root, created);
      entry = created;
    }
    entry.users++;
    entry.lastUsed = Date.now();
    this.scheduleEviction();
    if (!entry.finder) await entry.promise;
    return this.lease(entry);
  }

  /** Continuations can only lease their original live finder, never create one. */
  leaseExisting(root: string, finder: FileFinderApi): FinderLease | undefined {
    this.sweep();
    const entry = this.entries.get(root);
    if (!entry || entry.finder !== finder || finder.isDestroyed) return;
    entry.users++;
    entry.lastUsed = Date.now();
    this.scheduleEviction();
    return this.lease(entry);
  }

  size(): number { this.sweep(); return [...this.entries.values()].filter(entry => entry.finder).length; }

  destroy(): void {
    this.controller.abort();
    if (this.eviction) clearTimeout(this.eviction.timer);
    this.eviction = undefined;
    for (const entry of this.entries.values()) this.remove(entry);
  }

  private async create(entry: Entry): Promise<FileFinderApi> {
    if (this.controller.signal.aborted) throw new Error("Neural-search auxiliary index pool is closed.");
    this.trim(MAX_AUX - 1);
    if (this.options.enableHomeDirScanning && coversHomeDir(entry.root)) this.options.onHomeDirScan?.(entry.root);
    const finder = await this.options.pickers.create(entry.root, this.controller.signal, false);
    if (this.controller.signal.aborted) {
      if (!finder.isDestroyed) finder.destroy();
      throw new Error("Neural-search auxiliary pool closed during index creation.");
    }
    entry.finder = finder;
    entry.lastUsed = Date.now();
    this.trim(MAX_AUX);
    return finder;
  }

  private lease(entry: Entry): FinderLease {
    if (this.controller.signal.aborted || !entry.finder || entry.finder.isDestroyed) throw new Error("Neural-search auxiliary index is no longer available.");
    let held = true;
    return { finder: entry.finder, root: entry.root, release: () => {
      if (!held) return;
      held = false;
      entry.users--;
      entry.lastUsed = Date.now();
      this.sweep();
    } };
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.root) === entry) this.entries.delete(entry.root);
    this.scheduleEviction();
    if (entry.finder && !entry.finder.isDestroyed) entry.finder.destroy();
  }

  private sweep(): void {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.finder && (entry.finder.isDestroyed || entry.users === 0 && now - entry.lastUsed >= IDLE_TTL_MS)) this.remove(entry);
    }
    this.trim(MAX_AUX);
    this.scheduleEviction();
  }

  /** Only ready, idle indexes have deadlines; busy and pending leases own theirs. */
  private scheduleEviction(): void {
    let deadline = Infinity;
    if (!this.controller.signal.aborted) {
      for (const entry of this.entries.values()) {
        if (entry.finder && !entry.finder.isDestroyed && entry.users === 0)
          deadline = Math.min(deadline, entry.lastUsed + IDLE_TTL_MS);
      }
    }
    if (this.eviction?.deadline === deadline) return;
    if (this.eviction) clearTimeout(this.eviction.timer);
    this.eviction = undefined;
    if (deadline === Infinity) return;
    const timer = setTimeout(() => {
      this.eviction = undefined;
      this.sweep();
    }, Math.max(0, deadline - Date.now()));
    timer.unref();
    this.eviction = { timer, deadline };
  }

  private trim(limit: number): void {
    const ready = [...this.entries.values()].filter(entry => entry.finder);
    let excess = ready.length - limit;
    for (const entry of ready.filter(entry => entry.users === 0).sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (excess-- <= 0) break;
      this.remove(entry);
    }
  }
}
