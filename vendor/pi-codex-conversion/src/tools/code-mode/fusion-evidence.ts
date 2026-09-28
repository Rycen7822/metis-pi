import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fusionReceipt } from "../action-fusion.ts";
import type { RuntimeToolResult, ToolExecutionContext } from "./types.ts";

export interface FusionEvidenceRef { path: string; offsetBytes: number; bytes: number }
interface Journal { path: string; bytes: number; published: number; error?: string }

/** Durable receipts have a separate lifetime from the bounded display traces. */
export class FusionEvidenceStore {
	private readonly journals = new Map<string, Journal>();

	capture(cellId: string, id: string, toolName: string, input: unknown, result: RuntimeToolResult, context: ToolExecutionContext): void {
		if (!fusionReceipt(result.details)) return;
		let journal = this.journals.get(cellId);
		try {
			if (!journal) {
				const manager = context.extensionContext?.sessionManager;
				const sessionDir = manager?.getSessionDir();
				const directory = sessionDir ? join(sessionDir, `${manager!.getSessionId()}-blobs`) : join(tmpdir(), `metis-pi-fusion-${process.pid}`);
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				journal = { path: join(directory, `fusion-${randomUUID()}.jsonl`), bytes: 0, published: 0 };
				writeFileSync(journal.path, "", { flag: "wx", mode: 0o600 });
				this.journals.set(cellId, journal);
			}
			if (journal.error) return;
			const line = JSON.stringify({ version: 1, id, toolName, input, result, timestamp: Date.now() }) + "\n";
			appendFileSync(journal.path, line, "utf8");
			journal.bytes += Buffer.byteLength(line);
		} catch {
			journal ??= { path: "", bytes: 0, published: 0 };
			journal.error = "Fused tool evidence could not be persisted; display traces are incomplete recovery data.";
			this.journals.set(cellId, journal);
		}
	}

	take(cellId: string): { fusionEvidence?: FusionEvidenceRef; fusionEvidenceError?: string } {
		const journal = this.journals.get(cellId);
		if (!journal) return {};
		const ref = journal.bytes > journal.published ? { path: journal.path, offsetBytes: journal.published, bytes: journal.bytes - journal.published } : undefined;
		journal.published = journal.bytes;
		return { ...(ref ? { fusionEvidence: ref } : {}), ...(journal.error ? { fusionEvidenceError: journal.error } : {}) };
	}

	delete(cellId: string): void { this.journals.delete(cellId); }
	clear(): void { this.journals.clear(); }
}
