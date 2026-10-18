import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileFinderApi } from "@ff-labs/fff-node";
import { AuxFinderPool, type FinderLease } from "./native/aux-finders.ts";
import type { NeuralSearchConfig } from "./config.ts";
import { CursorStore, type SearchCursor } from "./cursors.ts";
import { FilePickerFactory } from "./native/file-picker.ts";
import { coversHomeDir, routePathConstraint, scanOptOutReason } from "./native/paths.ts";

export interface SearchScope {
  readonly id: string;
  readonly cwd: string;
  readonly session: string;
  readonly controller: AbortController;
  readonly pickers: FilePickerFactory;
  readonly pool: AuxFinderPool;
  ui?: ExtensionContext["ui"];
  main?: FileFinderApi;
  pending?: Promise<FileFinderApi>;
}
export type SearchLease = FinderLease & { constraint?: string; auxiliary: boolean };
const STATUS_KEY = "neural-search";

export class SearchRuntime {
  readonly cursors = new CursorStore();
  private active?: SearchScope;
  private closed = false;
  private homeTimer?: ReturnType<typeof setInterval>;
  constructor(readonly config: NeuralSearchConfig) {}

  start(ctx: ExtensionContext): SearchScope {
    this.closed = false;
    this.disposeScope();
    return this.bind(ctx);
  }

  bind(ctx?: ExtensionContext): SearchScope {
    if (this.closed) throw new Error("Neural-search session has shut down.");
    const cwd = path.resolve(ctx?.cwd ?? this.active?.cwd ?? process.cwd());
    const session = ctx?.sessionManager.getSessionId() ?? this.active?.session ?? "unbound";
    if (this.active?.cwd === cwd && this.active.session === session) {
      if (ctx) this.active.ui = ctx.ui;
      return this.active;
    }
    this.disposeScope();
    const controller = new AbortController();
    const pickers = new FilePickerFactory({ ...this.config,
      onDbFailure: error => {
        if (!controller.signal.aborted) this.active?.ui?.notify(
          `Neural search could not open its frecency/history databases (${error}). Continuing without persistence.`, "warning",
        );
      },
    });
    const scope: SearchScope = {
      id: randomUUID(), cwd, session, controller, pickers, ui: ctx?.ui,
      pool: new AuxFinderPool({ pickers, ...this.config,
        onHomeDirScan: root => { if (!controller.signal.aborted) this.warnHomeScan(root); },
      }),
    };
    this.active = scope;
    return scope;
  }

  current(): SearchScope {
    if (!this.active) throw new Error("Neural search has no active session.");
    this.assertCurrent(this.active);
    return this.active;
  }

  isCurrent(scope: SearchScope): boolean { return this.active === scope && !scope.controller.signal.aborted; }
  assertCurrent(scope: SearchScope): void {
    if (!this.isCurrent(scope)) throw new Error("Neural-search session or working directory changed during the operation. Retry in the current session.");
  }

  shutdown(): void { this.closed = true; this.disposeScope(); }

  async ensureMain(scope: SearchScope, signal?: AbortSignal): Promise<FileFinderApi> {
    signal?.throwIfAborted();
    this.assertCurrent(scope);
    const refusal = scanOptOutReason(scope.cwd, this.config);
    if (refusal) throw new Error(refusal);
    if (scope.main && !scope.main.isDestroyed) return scope.main;
    if (scope.pending) return waitForOperation(scope.pending, signal);
    const atHome = this.config.enableHomeDirScanning && coversHomeDir(scope.cwd);
    if (atHome) {
      this.warnHomeScan(scope.cwd);
      scope.ui?.setStatus(STATUS_KEY, "Agent is indexing $HOME; this can lead to high CPU");
    }
    const pending = scope.pickers.create(scope.cwd, scope.controller.signal)
      .then(finder => {
        if (!this.isCurrent(scope)) {
          if (!finder.isDestroyed) finder.destroy();
          throw new Error("Neural-search lifecycle ended during index creation.");
        }
        scope.main = finder;
        if (atHome) this.trackHomeScan(scope);
        return finder;
      }).catch(error => {
        if (this.isCurrent(scope) && atHome) this.stopHomeStatus();
        throw error;
      }).finally(() => { if (scope.pending === pending) scope.pending = undefined; });
    scope.pending = pending;
    return waitForOperation(pending, signal);
  }

  async acquire(scope: SearchScope, pathConstraint?: string, signal?: AbortSignal): Promise<SearchLease> {
    signal?.throwIfAborted();
    this.assertCurrent(scope);
    const route = routePathConstraint(pathConstraint, scope.cwd);
    if (!route) {
      const finder = await this.ensureMain(scope, signal);
      this.assertCurrent(scope);
      return { finder, root: scope.cwd, auxiliary: false,
        constraint: pathConstraint, release() {},
      };
    }
    const lease = await waitForOperation(scope.pool.acquire(route.root), signal, lease => lease.release());
    try {
      this.assertCurrent(scope);
      const rebase = path.relative(lease.root, route.root).replaceAll(path.sep, "/");
      // An empty suffix means route.root is a known directory. Preserve that
      // fact when a covering index rebases e.g. pkg.v1/ onto its parent.
      const include = route.suffix ? [rebase, route.suffix].filter(Boolean).join("/")
        : rebase ? `${rebase}/` : undefined;
      return { ...lease, auxiliary: true, constraint: include };
    } catch (error) { lease.release(); throw error; }
  }

  resume(scope: SearchScope, cursor: Pick<SearchCursor, "root" | "auxiliary" | "finder">, signal?: AbortSignal): SearchLease {
    signal?.throwIfAborted();
    this.assertCurrent(scope);
    const lease = cursor.auxiliary ? scope.pool.leaseExisting(cursor.root, cursor.finder)
      : scope.main === cursor.finder && scope.cwd === cursor.root && !cursor.finder.isDestroyed
        ? { root: scope.cwd, finder: cursor.finder, release() {} } : undefined;
    if (!lease) throw new Error("Stale neural-search cursor: its index has closed or changed. Repeat the search without a cursor.");
    return { ...lease, auxiliary: cursor.auxiliary };
  }

  private disposeScope(): void {
    this.stopHomeStatus();
    const scope = this.active;
    this.active = undefined;
    this.cursors.clear();
    if (!scope) return;
    scope.controller.abort();
    if (scope.main && !scope.main.isDestroyed) scope.main.destroy();
    scope.pool.destroy();
  }

  private warnHomeScan(root: string): void {
    if (this.config.warnOnHomeDirScan) this.active?.ui?.notify(
      `Neural search is indexing ${root}, covering the home tree. This can take additional time and resources. ` +
      "Set [neuralSearch].enableHomeDirScanning=false in metis-pi.toml to disable home indexing, or warnOnHomeDirScan=false to silence this warning.", "warning",
    );
  }

  private stopHomeStatus(): void {
    if (this.homeTimer) clearInterval(this.homeTimer);
    this.homeTimer = undefined;
    this.active?.ui?.setStatus(STATUS_KEY, undefined);
  }

  private trackHomeScan(scope: SearchScope): void {
    this.stopHomeStatus();
    const tick = () => {
      const progress = scope.main?.getScanProgress();
      if (!this.isCurrent(scope) || !progress?.ok || !progress.value.isScanning) { this.stopHomeStatus(); return; }
      scope.ui?.setStatus(STATUS_KEY, `Agent is indexing $HOME (${progress.value.scannedFilesCount} files); this can lead to high CPU`);
    };
    this.homeTimer = setInterval(tick, 1_000);
    this.homeTimer.unref();
    tick();
  }
}

/** Cancel only this waiter, not shared initialization. A late lease still
 * needs releasing; the shared main index remains owned by its scope. */
async function waitForOperation<T>(work: Promise<T>, signal?: AbortSignal, abandoned?: (value: T) => void): Promise<T> {
  if (!signal) return work;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const value = await Promise.race([work.then(value => {
      if (signal.aborted) { abandoned?.(value); signal.throwIfAborted(); }
      return value;
    }), cancelled]);
    if (signal.aborted) { abandoned?.(value); signal.throwIfAborted(); }
    return value;
  } finally { signal.removeEventListener("abort", onAbort); }
}
