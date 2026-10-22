import { StringDecoder } from "node:string_decoder";
import { getCodexShellArgs } from "../runtime-shell.ts";
import { chunkToBytes, createExecBridgeClient, type BridgeReadResponse } from "./bridge-client.ts";

const EXIT_OUTPUT_GRACE_MS = 100;

export interface BridgeExecInput {
	executionCommand: string;
	executionEnv: NodeJS.ProcessEnv;
	tty?: boolean | undefined;
	login?: boolean | undefined;
}

/** A process handle; delivery, waits, retention and public IDs belong to its manager. */
export interface BridgeExecProcess {
	readonly started: boolean;
	readonly exitCode: number | undefined;
	readonly terminating: boolean;
	readonly outputError: string | undefined;
	poll(waitMs?: number): Promise<void>;
	waitForStartup(signal?: AbortSignal): Promise<void>;
	write(chars: string): Promise<void>;
	terminate(): Promise<void>;
}

export interface BridgeSessionHooks {
	isOwned(): boolean;
	onOutput(text: string): void;
	onExit(): void;
}

export interface BridgeSessionRuntime {
	create(args: {
		processId: string;
		input: BridgeExecInput;
		workdir: string;
		shell: string;
		signal?: AbortSignal | undefined;
		hooks: BridgeSessionHooks;
	}): BridgeExecProcess;
	shutdown(): Promise<void>;
}

export function createBridgeSessionRuntime(binaryPath?: () => string | undefined): BridgeSessionRuntime {
	const bridge = createExecBridgeClient(binaryPath);
	let backgroundQueue = Promise.resolve();

	function create(args: Parameters<BridgeSessionRuntime["create"]>[0]): BridgeExecProcess {
		const { processId, input, workdir, shell, signal, hooks } = args;
		let startup: Promise<void>;
		let started = false;
		let exitCode: number | undefined;
		let terminating = false;
		let lastSeq = 0;
		let postExitIdleSince: number | undefined;
		let observedExitCode: number | null | undefined;
		let outputDecodersFlushed = false;
		let outputFailure: string | undefined;
		const outputDecoders = {
			stdout: new StringDecoder("utf8"),
			stderr: new StringDecoder("utf8"),
			pty: new StringDecoder("utf8"),
		};
		let pollQueue = Promise.resolve();

		function setExitCode(code: number | null | undefined, signal?: string | null): void {
			if (exitCode !== undefined) return;
			if (terminating) {
				exitCode = code && code !== 0 ? code : signal ? 128 + signalNumber(signal) : 143;
				return;
			}
			exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
		}

		async function readAndCommit(waitMs: number): Promise<void> {
			if (!hooks.isOwned() || exitCode !== undefined) return;
			const response = await bridge.request<BridgeReadResponse>({
				op: "read",
				process_id: processId,
				after_seq: lastSeq,
				wait_ms: waitMs,
			});
			if (!hooks.isOwned()) return;
			if (response.failure) {
				outputFailure ??= response.failure;
				hooks.onOutput("");
			}
			let receivedOutput = false;
			for (const chunk of response.chunks ?? []) {
				if (chunk.seq <= lastSeq) continue;
				const text = outputDecoders[chunk.stream].write(chunkToBytes(chunk.chunk));
				lastSeq = chunk.seq;
				hooks.onOutput(text);
				receivedOutput = true;
			}
			lastSeq = Math.max(lastSeq, response.nextSeq - 1);
			if (response.exited) {
				observedExitCode = response.exitCode;
				if (postExitIdleSince === undefined || receivedOutput) postExitIdleSince = Date.now();
			}
			const postExitIdle = postExitIdleSince !== undefined
				&& Date.now() - postExitIdleSince >= EXIT_OUTPUT_GRACE_MS;
			if (response.closed && !outputDecodersFlushed) {
				outputDecodersFlushed = true;
				for (const decoder of Object.values(outputDecoders)) hooks.onOutput(decoder.end());
			}
			if (response.closed || postExitIdle) {
				// Descendants can keep pipes open after the main process exits. The host's
				// idle cutoff stops waiting without treating their unfinished bytes as EOF.
				setExitCode(response.exitCode ?? observedExitCode);
				hooks.onExit();
			}
		}

		function poll(waitMs = 0): Promise<void> {
			// Capture the cursor inside this process's queue, after the preceding commit.
			const pending = pollQueue.then(() => readAndCommit(waitMs));
			pollQueue = pending.catch(() => {});
			return pending;
		}

		function fail(error: unknown): void {
			exitCode = 1;
			if (!hooks.isOwned()) return;
			hooks.onOutput(`${error instanceof Error ? error.message : String(error)}\n`);
			hooks.onExit();
		}

		async function pollLoop(): Promise<void> {
			while (hooks.isOwned() && exitCode === undefined) {
				try {
					// The helper reads requests serially: leave room for foreground operations
					// instead of filling its input with one long background wait per process.
					const pending = backgroundQueue.then(() => poll(250));
					backgroundQueue = pending.catch(() => {});
					await pending;
				} catch (error) {
					fail(error);
					return;
				}
			}
		}

		// Return the handle before startup can notify the manager that publishes it.
		startup = Promise.resolve().then(async () => {
			try {
				const shellArgs = getCodexShellArgs(shell, input.executionCommand, input.login ?? true);
				await bridge.request({
					op: "exec",
					process_id: processId,
					argv: [shell, ...shellArgs],
					cwd: workdir,
					env: input.executionEnv,
					tty: Boolean(input.tty),
					pipe_stdin: Boolean(input.tty),
					arg0: null,
				});
				started = true;
				if (signal?.aborted) {
					terminating = true;
					await bridge.request({ op: "terminate", process_id: processId });
				}
				void pollLoop();
			} catch (error) {
				fail(error);
			}
		});

		async function waitForStartup(signal?: AbortSignal): Promise<void> {
			if (!signal) return startup;
			if (signal.aborted) throw new Error("exec_command aborted");
			let removeAbortListener = () => {};
			const aborted = new Promise<never>((_, reject) => {
				const onAbort = () => reject(new Error("exec_command aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			});
			try {
				await Promise.race([startup, aborted]);
			} finally {
				removeAbortListener();
			}
		}

		return {
			get started() { return started; },
			get exitCode() { return exitCode; },
			get terminating() { return terminating; },
			get outputError() {
				return outputFailure ?? (started && exitCode !== undefined && !outputDecodersFlushed
					? "Output capture ended before all output streams closed; later output may be omitted."
					: undefined);
			},
			poll,
			waitForStartup,
			write: async (chars) => {
				await startup;
				const { status } = await bridge.request<{ status: string }>({
					op: "write", process_id: processId, chunk: Array.from(Buffer.from(chars, "utf8")),
				});
				if (status !== "accepted") throw new Error(`Process stdin write not accepted: ${status}`);
			},
			terminate: async () => {
				terminating = true;
				await startup;
				if (started && exitCode === undefined) await bridge.request({ op: "terminate", process_id: processId });
			},
		};
	}

	return { create, shutdown: () => bridge.shutdown() };
}

function signalNumber(signal: string): number {
	if (signal === "SIGTERM") return 15;
	if (signal === "SIGKILL") return 9;
	if (signal === "SIGINT") return 2;
	const numericSignal = /^SIG(\d+)$/.exec(signal)?.[1];
	return numericSignal ? Number.parseInt(numericSignal, 10) : 1;
}
