import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { createBashToolDefinition, createLocalBashOperations, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getPiConfiguredShellPath } from "./runtime-shell.ts";
import { ExecOutputArchive } from "./exec/output-archive.ts";
import { validateThenRun, type ThenRunInput, type FusionCommandResult } from "./action-fusion.ts";

export function fusionArchiveDirectory(ctx: ExtensionContext): string {
	const directory = ctx.sessionManager.getSessionDir();
	return directory ? join(directory, `${ctx.sessionManager.getSessionId()}-blobs`) : join(tmpdir(), `metis-pi-fusion-${process.pid}`);
}

/** Native shell owns spawning/env/process cleanup; this wrapper captures evidence before truncation. */
export async function runNativeFusionCommand(input: ThenRunInput, ctx: ExtensionToolContext, signal?: AbortSignal, update?: (result: FusionCommandResult) => void): Promise<FusionCommandResult> {
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
