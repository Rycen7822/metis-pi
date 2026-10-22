import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

function runEditor(command: string, file: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	// Keep the command grammar identical to Pi's built-in external-editor flow. A
	// separate shell or argv parser here would make Ctrl+G behave differently.
	const [editor, ...args] = command.split(" ");
	if (!editor) return Promise.reject(new Error("External editor command is empty"));

	return new Promise((resolve, reject) => {
		const child = spawn(editor, [...args, file], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		let launchError: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
			killTimer.unref();
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.once("error", (error) => { launchError = error; });
		child.once("close", (code, exitSignal) => {
			signal?.removeEventListener("abort", abort);
			clearTimeout(killTimer);
			if (signal?.aborted || launchError) {
				reject(signal?.aborted ? signal.reason : launchError);
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}
			const reason = exitSignal ? `signal ${exitSignal}` : `exit code ${code ?? "unknown"}`;
			reject(new Error(`External editor exited with ${reason}`));
		});
	});
}

/**
 * Edit a custom answer with Pi's configured external-editor command. The TUI lifecycle
 * and one-trailing-newline normalization intentionally match Pi's main editor flow.
 */
export async function editWithExternalEditor(
	tui: ExternalEditorTui, command: string, value: string, signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const tempDir = mkdtempSync(join(tmpdir(), "rpiv-ask-user-question-"));
	const tempFile = join(tempDir, "answer.md");
	let tuiStopped = false;

	try {
		writeFileSync(tempFile, value, "utf8");
		tui.stop();
		tuiStopped = true;
		process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);
		await runEditor(command, tempFile, signal);
		return readFileSync(tempFile, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort; never leave the TUI stopped because it failed.
		}
		if (tuiStopped) {
			tui.start();
			tui.requestRender(true);
		}
	}
}
