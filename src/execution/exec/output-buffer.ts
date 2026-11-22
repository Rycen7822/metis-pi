import type { ExecOutputArchive } from "./output-archive.ts";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_RESIDENT_CHARS = 1024 * 1024;
const MAX_FALLBACK_CHARS = 8 * MAX_RESIDENT_CHARS; // 16 MiB at two bytes per UTF-16 code unit.
const IO_CHUNK_CHARS = 64 * 1024;
let fallbackCharsInUse = 0;

const detach = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");

/** A UTF-16 ring: retain the configured character budget without keeping it all on the heap. */
export class ExecOutputBuffer {
	startOffset = 0;
	endOffset = 0;
	private memory = "";
	private spool: { directory: string; fd: number } | undefined;
	private fallbackLength?: number;
	private fallbackOmitted = false;
	private failure: Error | undefined;
	private disposed = false;
	private readonly maxChars: number;

	readonly archive: ExecOutputArchive | undefined;
	constructor(maxChars: number, archive?: ExecOutputArchive) {
		this.archive = archive;
		this.maxChars = Math.max(1, Math.floor(maxChars));
	}

	get length(): number {
		return this.endOffset - this.startOffset;
	}

	get fallbackStartOffset(): number | undefined {
		return this.fallbackOmitted ? this.startOffset : undefined;
	}

	append(text: string): void {
		if (this.disposed || this.failure || text.length === 0) return;
		const end = this.endOffset + text.length;
		const start = Math.max(this.startOffset, end - this.maxChars);
		if (!this.spool && this.fallbackLength === undefined && end - start > MAX_RESIDENT_CHARS) this.openSpool();
		if (!this.spool) { this.appendResident(text, start, end); return; }
		try {
			this.writeRing(text.slice(Math.max(0, start - this.endOffset)), Math.max(start, this.endOffset));
		} catch {
			this.fallbackLength = 0;
			try { this.appendResident(text, start, end); }
			finally { this.closeSpool(); }
			return;
		}
		this.startOffset = start;
		this.endOffset = end;
		if (start === 0) return;
		try { if (/[\uDC00-\uDFFF]/.test(this.readRange(start, start + 1))) this.startOffset++; }
		catch (error) { this.fail(error); }
	}

	private appendResident(text: string, diskStart: number, end: number): void {
		let start = diskStart;
		if (this.fallbackLength !== undefined) {
			const available = MAX_FALLBACK_CHARS - fallbackCharsInUse + this.fallbackLength;
			start = Math.max(start, end - Math.min(MAX_RESIDENT_CHARS, available));
		}
		let previous = "";
		if (start < this.endOffset) {
			// Even after a partial ring write, the bounded range above diskStart is intact.
			if (this.spool) {
				try { previous = this.readRange(start, this.endOffset); }
				catch { start = this.endOffset; }
			} else previous = this.memory.slice(start - this.startOffset);
		}
		let memory = previous + text.slice(Math.max(0, start - this.endOffset));
		if (start > 0 && /^[\uDC00-\uDFFF]/.test(memory)) { start++; memory = memory.slice(1); }
		this.fallbackOmitted ||= this.fallbackLength !== undefined && start > diskStart;
		this.setMemory(start > this.startOffset ? detach(memory) : memory);
		this.startOffset = start;
		this.endOffset = end;
	}

	private setMemory(text: string): void {
		if (this.fallbackLength !== undefined) {
			fallbackCharsInUse += text.length - this.fallbackLength;
			this.fallbackLength = text.length;
		}
		this.memory = text;
	}

	/** String.slice semantics, but only the requested range is materialized. */
	slice(start = 0, end = this.length): string {
		if (this.failure) throw this.failure;
		const relative = (offset: number) => {
			const integer = Math.trunc(offset) || 0;
			return integer < 0 ? Math.max(0, this.length + integer) : Math.min(this.length, integer);
		};
		const from = relative(start);
		const to = Math.max(from, relative(end));
		try {
			return this.readRange(this.startOffset + from, this.startOffset + to);
		} catch (error) {
			this.fail(error);
			throw this.failure;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.archive?.close();
		this.setMemory("");
		this.closeSpool();
	}

	private openSpool(): void {
		let directory: string | undefined;
		try {
			directory = fs.mkdtempSync(join(tmpdir(), "pi-exec-output-"));
			this.spool = { directory, fd: fs.openSync(join(directory, "output"), "wx+", 0o600) };
			this.writeRing(this.memory, this.startOffset);
			this.memory = "";
		} catch {
			if (this.spool) this.closeSpool();
			else if (directory) fs.rmSync(directory, { recursive: true, force: true });
			this.fallbackLength = 0;
		}
	}

	private writeRing(text: string, offset: number): void {
		const fd = this.spool!.fd;
		for (let written = 0; written < text.length;) {
			const position = (offset + written) % this.maxChars;
			const count = Math.min(text.length - written, this.maxChars - position, IO_CHUNK_CHARS);
			const bytes = Buffer.from(text.slice(written, written + count), "utf16le");
			for (let done = 0; done < bytes.length;) {
				const size = fs.writeSync(fd, bytes, done, bytes.length - done, position * 2 + done);
				if (size === 0) throw new Error("exec output spool write made no progress");
				done += size;
			}
			written += count;
		}
	}

	private readRange(start: number, end: number): string {
		if (!this.spool) {
			const text = this.memory.slice(start - this.startOffset, end - this.startOffset);
			// Detach small results/replay tails from a potentially large backing string.
			return detach(text);
		}
		const bytes = Buffer.allocUnsafe((end - start) * 2);
		for (let read = 0; read < bytes.length;) {
			const position = (start * 2 + read) % (this.maxChars * 2);
			const count = Math.min(bytes.length - read, this.maxChars * 2 - position);
			const size = fs.readSync(this.spool.fd, bytes, read, count, position);
			if (size === 0) throw new Error("exec output spool ended unexpectedly");
			read += size;
		}
		return bytes.toString("utf16le");
	}

	private fail(error: unknown): void {
		this.failure ??= new Error("Cannot recover exec output from its temporary spool", { cause: error });
		this.setMemory("");
		this.closeSpool();
	}

	private closeSpool(): void {
		const spool = this.spool;
		if (!spool) return;
		this.spool = undefined;
		try {
			fs.closeSync(spool.fd);
		} finally {
			fs.rmSync(spool.directory, { recursive: true, force: true });
		}
	}
}
