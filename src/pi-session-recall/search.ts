import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface FileMatchCount {
	path: string;
	/** Each matching JSONL line counts once, regardless of occurrences. */
	count: number;
}

function requireQuery(query: string): void {
	if (query.length === 0) {
		throw new Error("Search query must not be empty.");
	}
}

function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function externalSearch(command: "rg" | "grep", args: string[], signal: AbortSignal): Promise<string | undefined> {
	signal.throwIfAborted();
	try {
		const { stdout } = await run(command, args, { encoding: "utf8", signal, maxBuffer: 8 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		signal.throwIfAborted();
		if ((error as { code?: unknown }).code === 1) return "";
		// Missing or failed external search falls back to the same line contract.
		return undefined;
	}
}

async function* jsonlFiles(dir: string, signal: AbortSignal): AsyncGenerator<string> {
	signal.throwIfAborted();
	let entries;
	try { entries = await readdir(dir, { withFileTypes: true }); }
	catch { signal.throwIfAborted(); return; }
	for (const entry of entries) {
		signal.throwIfAborted();
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* jsonlFiles(path, signal);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
	}
}

/** Streams one record at a time; cancellation also closes the file stream. */
async function* linesOf(path: string, signal: AbortSignal): AsyncGenerator<string> {
	signal.throwIfAborted();
	const stream = createReadStream(path, { encoding: "utf8", signal });
	let pending = "";
	try {
		for await (const chunk of stream) {
			signal.throwIfAborted();
			pending += chunk;
			let end: number;
			while ((end = pending.indexOf("\n")) >= 0) {
				signal.throwIfAborted();
				yield pending.slice(0, end).replace(/\r$/, "");
				pending = pending.slice(end + 1);
			}
		}
		if (pending) yield pending.replace(/\r$/, "");
	} finally { stream.destroy(); }
}

function countsOf(output: string): FileMatchCount[] {
	return output.trim().split("\n").filter(Boolean).flatMap(line => {
		const colon = line.lastIndexOf(":");
		const count = Number(line.slice(colon + 1));
		return colon >= 0 && Number.isInteger(count) && count > 0 ? [{ path: line.slice(0, colon), count }] : [];
	});
}

/** A shared deadline covers external attempts and the streaming Node fallback. */
export async function searchFiles(query: string, dir: string, callerSignal?: AbortSignal): Promise<FileMatchCount[]> {
	requireQuery(query);
	callerSignal?.throwIfAborted();
	// JSONL records occupy one physical line. Do not let external tools turn a
	// literal newline into multiple independent search patterns.
	if (/[\r\n]/.test(query)) return [];
	const signal = deadline(callerSignal, 10_000);
	for (const [command, args] of [
		["rg", ["-i", "-c", "-F", "--hidden", "--no-ignore", "--glob", "*.jsonl", "--", query, dir]],
		["grep", ["-r", "-i", "-c", "-F", "--include=*.jsonl", "--", query, dir]],
	] as const) {
		const output = await externalSearch(command, [...args], signal);
		if (output !== undefined) return countsOf(output);
	}
	const needle = query.toLowerCase();
	const results: FileMatchCount[] = [];
	for await (const path of jsonlFiles(dir, signal)) {
		let count = 0;
		try {
			for await (const line of linesOf(path, signal)) {
				if (line.toLowerCase().includes(needle)) count++;
			}
		} catch { signal.throwIfAborted(); continue; }
		if (count) results.push({ path, count });
	}
	signal.throwIfAborted();
	return results;
}

export async function searchLines(query: string, path: string, limit: number, callerSignal?: AbortSignal): Promise<string[]> {
	requireQuery(query);
	callerSignal?.throwIfAborted();
	if (/[\r\n]/.test(query)) return [];
	if (!Number.isInteger(limit) || limit < 1) throw new Error("Search line limit must be a positive integer.");
	const signal = deadline(callerSignal, 5_000);
	for (const command of ["rg", "grep"] as const) {
		const output = await externalSearch(command, ["-i", "-F", "-m", String(limit), "--", query, path], signal);
		if (output !== undefined) return output.trimEnd().split("\n").filter(Boolean);
	}
	const matches: string[] = [];
	try {
		for await (const line of linesOf(path, signal)) {
			if (line.toLowerCase().includes(query.toLowerCase())) matches.push(line);
			if (matches.length === limit) break;
		}
	} catch { signal.throwIfAborted(); }
	signal.throwIfAborted();
	return matches;
}
