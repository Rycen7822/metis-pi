import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { createBashToolDefinition, createLocalBashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiConfiguredShellPath } from "../adapter/prompt/runtime-shell.ts";
import { ExecOutputArchive } from "./exec/output-archive.ts";
import { validateThenRun, type ThenRunInput, type FusionCommandResult } from "./action-fusion.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec/session-manager.ts";

export function fusionArchiveDirectory(ctx: ExtensionContext): string {
	const directory = ctx.sessionManager.getSessionDir();
	return directory ? join(directory, `${ctx.sessionManager.getSessionId()}-blobs`) : join(tmpdir(), `metis-pi-fusion-${process.pid}`);
}

/** Native shell owns spawning/env/process cleanup; this wrapper captures evidence before truncation. */
export async function runNativeFusionCommand(input: ThenRunInput, ctx: ExtensionContext, signal?: AbortSignal, update?: (result: FusionCommandResult) => void): Promise<FusionCommandResult> {
	validateThenRun(input);
	const archive = new ExecOutputArchive(fusionArchiveDirectory(ctx), 0);
	const decoder = new StringDecoder("utf8");
	let output = "", exitCode: number | undefined, failure: unknown;
	const append = (text: string) => { archive.append(text); output = (output + text).slice(-32_768); };
	const shellPath = getPiConfiguredShellPath(ctx);
	const local = createLocalBashOperations(shellPath ? { shellPath } : {});
	const bash = createBashToolDefinition(ctx.cwd, {
		operations: {
			async exec(command, cwd, options) {
				try {
					const result = await local.exec(command, cwd, { ...options, onData(data) { append(decoder.write(data)); options.onData(data); } });
					exitCode = result.exitCode ?? undefined;
					return result;
				} catch (error) { failure = error; throw error; }
				finally { append(decoder.end()); }
			},
		},
	});
	try {
		await bash.execute("then-run", input, signal, () => update?.({ status: "running", output, ...archive.info() }), ctx);
	} catch (error) { failure ??= error; }
	finally { archive.preserve(); archive.close(); }
	const error = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);
	const status = signal?.aborted ? "cancelled" : error?.startsWith("timeout:") ? "timed_out" : exitCode === 0 && !failure ? "succeeded" : "failed";
	return { status, output, exitCode, ...(error ? { error: exitCode === undefined ? error.slice(-1500) : `Command exited with code ${exitCode}` } : {}), ...archive.info() };
}

/** Conversion retains its existing session/env/bridge ownership and output decoder. */
export async function runExecFusionCommand(sessions: ExecSessionManager, input: ThenRunInput, ctx: ExtensionContext, signal?: AbortSignal, update?: (result: FusionCommandResult) => void): Promise<FusionCommandResult> {
	validateThenRun(input);
	if (signal?.aborted) return { status: "cancelled", output: "", error: "Cancelled before command start" };
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = input.timeout === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); }, input.timeout * 1000);
	const receipt = (result: UnifiedExecResult): FusionCommandResult => ({
		status: signal?.aborted ? "cancelled" : timedOut ? "timed_out" : result.interrupted ? "cancelled" : result.exit_code === 0 ? "succeeded" : result.exit_code === undefined ? "running" : "failed",
		output: result.output,
		exitCode: result.exit_code,
		fullOutputPath: result.fullOutputPath, fullOutputBytes: result.fullOutputBytes,
		fullOutputComplete: result.fullOutputComplete, fullOutputAppendOnly: result.fullOutputAppendOnly,
		fullOutputError: result.fullOutputError,
	});
	try {
		const result = await sessions.exec({ cmd: input.command, defaultShell: getPiConfiguredShellPath(ctx), wait_until_exit: true,
			archiveDirectory: fusionArchiveDirectory(ctx), archiveAllOutput: true, captureInterruptedResult: true,
			max_output_tokens: 8192,
		}, ctx.cwd, controller.signal, partial => update?.(receipt(partial)));
		return receipt(result);
	} catch (error) {
		return { status: signal?.aborted ? "cancelled" : timedOut ? "timed_out" : "failed", output: "", error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer); signal?.removeEventListener("abort", abort);
	}
}
