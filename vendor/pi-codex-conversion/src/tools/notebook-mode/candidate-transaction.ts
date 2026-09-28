import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import {
	MAX_PROJECT_ENTRIES,
	MAX_PROJECT_MANIFEST_BYTES,
	MAX_PROJECT_NAME_BYTES,
	readProjectStateCandidate,
	type ProjectStateCandidate,
} from "./project-state-format.ts";
import { projectStateCaptureSource } from "./project-state-runtime.ts";

// Shared Node-side half of the notebook capture/publish transaction: candidate
// allocation, kernel capture, candidate verification/cleanup and atomic manifest
// publication. Store-specific rules — generation merge and pins (project), profile
// naming and collision rules, checkpoint identity — stay with the callers, and the
// Deno-injected checkpoint protocol keeps publishing its own files.

/** Reject a capture the kernel would otherwise only refuse after doing the work. */
export function assertCandidateNames(names: readonly string[], label: string): void {
	if (names.length > MAX_PROJECT_ENTRIES) throw new Error(`${label} exceeds ${MAX_PROJECT_ENTRIES} top-level values`);
	if (names.some((name) => Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES)) {
		throw new Error(`${label} name exceeds ${MAX_PROJECT_NAME_BYTES} bytes`);
	}
}

/**
 * Capture the named bindings into fresh candidate files, verify them, and always
 * remove both files again. The caller owns the candidate list and the failure text.
 */
export async function captureNotebookCandidate(options: {
	directory: string;
	kernel: DenoJupyterKernel;
	names: readonly string[];
	maxBytes: number;
	signal?: AbortSignal | undefined;
	/** Prefix for a capture that reported an error. */
	failureMessage: string;
	/** Message for a capture that produced no valid candidate. */
	invalidMessage: string;
}): Promise<{ candidate: ProjectStateCandidate; payload: Buffer }> {
	const id = randomUUID();
	const payloadPath = join(options.directory, `candidate-${id}.bin`);
	const manifestPath = join(options.directory, `candidate-${id}.json`);
	try {
		const capture = await options.kernel.execute(projectStateCaptureSource({
			candidates: [...options.names],
			payloadPath,
			manifestPath,
			maxBytes: options.maxBytes,
		}), options.signal ? { signal: options.signal } : {});
		if (capture.status !== "ok") throw new Error(`${options.failureMessage}: ${capture.errorText ?? "unknown error"}`);
		const candidate = readProjectStateCandidate(manifestPath, payloadPath, options.maxBytes);
		if (!candidate) throw new Error(options.invalidMessage);
		return { candidate, payload: readFileSync(payloadPath) };
	} finally {
		rmSync(payloadPath, { force: true });
		rmSync(manifestPath, { force: true });
	}
}

/**
 * Write the payload, then publish its manifest through a temporary file + rename.
 * Returns the superseded payload path so each store keeps its own cleanup policy
 * (project ignores a failure there, profile propagates it).
 */
export function publishNotebookManifest(options: {
	directory: string;
	manifestPath: string;
	manifest: unknown;
	payloadName: string;
	payload: Buffer;
	previousPayload?: string | undefined;
	/** Owner name used in the manifest size error. */
	label: string;
}): string | undefined {
	const text = `${JSON.stringify(options.manifest, null, 2)}\n`;
	if (Buffer.byteLength(text) > MAX_PROJECT_MANIFEST_BYTES) {
		throw new Error(`${options.label} manifest exceeds ${MAX_PROJECT_MANIFEST_BYTES} bytes`);
	}
	writeFileSync(join(options.directory, options.payloadName), options.payload, { mode: 0o600 });
	const temporary = `${options.manifestPath}.${randomUUID()}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, options.manifestPath);
	return options.previousPayload && options.previousPayload !== options.payloadName
		? join(options.directory, options.previousPayload)
		: undefined;
}
