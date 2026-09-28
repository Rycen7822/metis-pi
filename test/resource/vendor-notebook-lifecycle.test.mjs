// Notebook session ownership: these tests drive the real NotebookSessionRuntime and its
// execution/lifecycle wiring against a CONTROLLED kernel and the real bridge server. The
// kernel stand-in answers the production source strings at the real call boundary: capture
// sources run the shipped checkpoint/project code in-process (Node v8 + a small Deno file
// stand-in), cells stay pending until the test or a stop/interrupt settles them.
//
// Scope: session/kernel/bridge lifecycle only. This is NOT evidence that a real Deno
// Jupyter kernel started or executed cells; that remains covered by the runtime itself.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NotebookSessionRuntime } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/session-runtime.js";
import { initializeNotebookJournal } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/journal.js";
import { notebookCheckpointIdentity } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/session-startup.js";
import { NOTEBOOK_KERNEL_FAILURE_NOTICE } from "../../vendor/pi-codex-conversion/dist/tools/notebook-mode/runtime-health.js";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { runCaptureSource } from "../helpers/vendor-notebook-capture.mjs";

const EXEC_YIELD = '// @exec: {"yield_time_ms": 5}\nawait longRunning();';

function executionContext(dir, epoch) {
	const branch = epoch === undefined
		? []
		: [{ type: "custom", customType: "pi-codex-conversion-notebook-tree-epoch", data: { epoch } }];
	return {
		extensionContext: {
			cwd: dir,
			sessionManager: { getSessionId: () => "notebook-session", getSessionDir: () => dir, getBranch: () => branch },
			ui: { notify: () => {} },
		},
	};
}

/**
 * Controlled kernel boundary. `startModes`:
 *   immediate - starts at once; `abort` - rejects when the startup signal aborts;
 *   late      - ignores the signal and only resolves when the test releases it.
 * Cells whose source calls `longRunning()` stay pending until interrupt/shutdown/release;
 * every other cell completes immediately.
 */
function controlledKernel({ startModes = [] } = {}) {
	const events = [];
	const kernels = [];
	const starts = [];
	const bindings = { alpha: 7 };
	const baseline = ["builtin"];
	const names = [...baseline, ...Object.keys(bindings)];
	const create = () => {
		const mode = startModes[kernels.length] ?? "immediate";
		const kernel = {
			starts: 0, shutdowns: 0, interrupts: 0, executes: [], pendingCell: undefined, releaseStart: undefined,
			start(signal) {
				this.starts += 1;
				events.push("start");
				if (mode === "immediate") {
					signal?.throwIfAborted();
					return Promise.resolve();
				}
				return new Promise((resolveStart, rejectStart) => {
					if (mode === "abort") {
						if (signal?.aborted) rejectStart(new Error("startup aborted"));
						else signal?.addEventListener("abort", () => rejectStart(new Error("startup aborted")), { once: true });
					} else {
						this.releaseStart = resolveStart;
					}
				});
			},
			async execute(source, options = {}) {
				this.executes.push(source);
				if (source.includes('await import("node:v8")')) {
					await runCaptureSource(source, bindings);
					return { status: "ok", items: [] };
				}
				// Injected-kernel protocols answer with a marker-tagged JSON line; this stand-in
				// reports the empty result (no project bindings, nothing to dispose).
				const marker = source.match(/console\.log\("([^"]+)"/)?.[1];
				if (marker) {
					const payload = source.includes("projectBindings") ? "[]" : '{"released":[],"disposed":[],"failures":[]}';
					return { status: "ok", items: [{ type: "input_text", text: `${marker}${payload}` }] };
				}
				if (options.cellSource !== undefined) {
					events.push("cell");
					if (options.cellSource.includes("longRunning")) {
						return new Promise((resolveCell) => { this.pendingCell = resolveCell; });
					}
				}
				options.onOutput?.({ type: "input_text", text: "cell output" });
				return { status: "ok", items: [{ type: "input_text", text: "cell output" }] };
			},
			async complete() { return names; },
			async interrupt() {
				this.interrupts += 1;
				events.push("interrupt");
				this.settleCell();
			},
			async shutdown() {
				this.shutdowns += 1;
				events.push("kernel-shutdown");
				this.settleCell();
			},
			settleCell() {
				const settle = this.pendingCell;
				this.pendingCell = undefined;
				settle?.({ status: "aborted", items: [] });
			},
		};
		kernels.push(kernel);
		return kernel;
	};
	return {
		events, kernels, starts, create, baselineNames: baseline,
		fail: (kernel) => kernel.onFailure(kernel, new Error("kernel died")),
	};
}

/** The session owner under test, with the real startup replaced by the controlled kernel. */
class ControlledSession extends NotebookSessionRuntime {
	constructor(options, controlled) {
		super(options);
		this.controlled = controlled;
	}

	async startSession(options) {
		await options.bridge.start();
		this.controlled.starts.push(options.runtime);
		const kernel = this.controlled.create();
		kernel.onFailure = options.onKernelFailure;
		try {
			await kernel.start(options.signal);
			const identity = notebookCheckpointIdentity(options.context, options.runtime.agentDir);
			return {
				kernel,
				journal: initializeNotebookJournal(identity, options.checkpointMaxBytes),
				checkpointIdentity: identity,
				baselineNames: new Set(this.controlled.baselineNames),
				projectBaseline: { generation: "root", entries: [] },
				configuredProfileLoaded: false,
			};
		} catch (error) {
			await kernel.shutdown().catch(() => undefined);
			throw error;
		}
	}
}

/** The controlled session under test with its own temp dir; cleanup shuts the session down. */
function controlledSession(t, kernelOptions = {}, options = {}) {
	let session;
	t.after(() => session?.shutdown());
	const dir = temporaryDirectory(t, "metis-notebook-lifecycle-");
	const controlled = controlledKernel(kernelOptions);
	session = new ControlledSession({ maxHeapMiB: 64, agentDir: dir, ...options }, controlled);
	return { dir, controlled, session };
}

/** Cache-relative name of a materialized session file; the cache layout is internal. */
function cacheFile(dir, suffix) {
	return readdirSync(join(dir, "cache"), { recursive: true }).find((entry) => entry.endsWith(suffix));
}

test("an aborted startup shuts its partial kernel down and the next operation rebuilds", async (t) => {
	const { dir, controlled, session } = controlledSession(t, { startModes: ["abort", "immediate"] });

	const controller = new AbortController();
	const pending = session.execute("1 + 1", executionContext(dir), controller.signal);
	controller.abort(new Error("user cancelled"));
	await assert.rejects(pending);
	assert.equal(session.kernel(), undefined);
	assert.equal(controlled.kernels[0].shutdowns, 1, "the partial kernel is shut down");
	assert.equal(session.runtimeHealth().state, "not_started");

	const rebuilt = await session.execute("1 + 1", executionContext(dir));
	assert.equal(rebuilt.kind, "result");
	assert.equal(controlled.kernels.length, 2, "the cancelled attempt is not reused");
	assert.equal(session.runtimeHealth().state, "ready");
});

test("a startup that resolves after shutdown is discarded instead of reviving the session", async (t) => {
	const { dir, controlled, session } = controlledSession(t, { startModes: ["late"] });

	const starting = session.prepare(executionContext(dir));
	const shutting = session.shutdown();
	let kernel = controlled.kernels[0];
	for (let attempt = 0; attempt < 500 && !kernel?.releaseStart; attempt += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		kernel = controlled.kernels[0];
	}
	assert.ok(kernel?.releaseStart, "the controlled kernel did not reach its start");
	kernel.releaseStart();
	await Promise.all([starting.catch(() => undefined), shutting]);

	assert.equal(session.kernel(), undefined, "the late kernel is not installed");
	assert.equal(controlled.kernels[0].shutdowns, 1, "the late kernel is shut down");
	assert.equal(controlled.kernels[0].executes.length, 0, "the discarded kernel is never used");
	assert.equal(session.runtimeHealth().state, "not_started");
});

test("an active cell is interrupted before the kernel and journal are torn down, and shutdown repeats", async (t) => {
	const { dir, controlled, session } = controlledSession(t);

	const running = await session.execute(EXEC_YIELD, executionContext(dir));
	assert.equal(running.kind, "yielded");
	assert.equal(session.activeCellId(), running.cellId);

	await session.shutdown();
	assert.equal(session.activeCellId(), undefined);
	assert.equal(controlled.kernels[0].interrupts, 1, "the running cell is interrupted");
	assert.ok(controlled.events.indexOf("interrupt") < controlled.events.indexOf("kernel-shutdown"), "execution stops before kernel teardown");
	assert.equal(controlled.kernels[0].shutdowns, 1);
	const journal = cacheFile(dir, ".ipynb");
	assert.ok(journal, "the session journal is materialized on shutdown");
	assert.match(readFileSync(join(dir, "cache", journal), "utf8"), /longRunning/, "the in-flight cell is recorded in the journal");

	await session.shutdown();
	assert.equal(controlled.kernels[0].shutdowns, 1, "a repeated shutdown does not touch the kernel again");
});

test("a failed kernel and a new session identity are rebuilt from the session identity", async (t) => {
	const { dir, controlled, session } = controlledSession(t);

	await session.execute("1 + 1", executionContext(dir));
	assert.equal(session.runtimeHealth().state, "ready");

	// A terminal kernel failure invalidates the session; the next operation recreates it.
	controlled.fail(controlled.kernels[0]);
	assert.equal(session.kernel(), undefined);
	assert.equal(session.runtimeHealth().state, "invalidated");
	const rebuilt = await session.execute("2 + 2", executionContext(dir));
	assert.equal(controlled.kernels.length, 2);
	assert.equal(session.runtimeHealth().state, "ready");
	assert.ok(JSON.stringify(rebuilt).includes(NOTEBOOK_KERNEL_FAILURE_NOTICE), "the failure notice reaches the next result");

	// A different session identity must not reuse the previous session's kernel.
	await session.prepare(executionContext(dir, "epoch-2"));
	assert.equal(controlled.kernels.length, 3);
	assert.equal(controlled.kernels[1].shutdowns, 1, "the previous identity's kernel is shut down");
	assert.equal(session.runtimeHealth().state, "ready");
	assert.equal(controlled.kernels[2].starts, 1, "the new identity starts its own kernel");
});

test("reset stops the active cell, discards the session checkpoint and restarts without the profile", async (t) => {
	const { dir, controlled, session } = controlledSession(t, {}, { profile: "named" });

	await session.execute("1 + 1", executionContext(dir));
	await session.checkpoint();
	const checkpoint = cacheFile(dir, "checkpoint.json");
	assert.ok(checkpoint, "the running session checkpoint is on disk");
	const checkpointDir = join(dir, "cache", checkpoint, "..");
	writeFileSync(join(checkpointDir, "stale-sentinel"), "stale");

	const running = await session.execute(EXEC_YIELD, executionContext(dir));
	assert.equal(running.kind, "yielded");
	const reset = await session.controlNotebook({ action: "reset" }, executionContext(dir));

	assert.equal(reset.details.discardedSessionCheckpoint, true);
	assert.equal(reset.details.terminatedCell, running.cellId);
	assert.equal(session.activeCellId(), undefined);
	assert.equal(controlled.starts[0].profile, "named");
	assert.equal(controlled.starts.at(-1).profile, undefined, "the clean restart skips the configured profile");
	assert.ok(controlled.events.indexOf("interrupt") < controlled.events.lastIndexOf("start"), "execution stops before the clean restart starts");
	assert.equal(existsSync(join(checkpointDir, "stale-sentinel")), false, "the session checkpoint is discarded");
	assert.ok(cacheFile(dir, "checkpoint.json"), "the clean session persists a fresh checkpoint");
	assert.equal(session.runtimeHealth().state, "ready");
});
