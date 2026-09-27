import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Durable decoded process output, independent of the bounded display ring. */
export class ExecOutputArchive {
	private pending = "";
	private fd: number | undefined;
	private path: string | undefined;
	private bytes = 0;
	private failed = false;
	private closed = false;
	private readonly directory: string;
	private readonly threshold: number;
	constructor(directory: string, threshold: number) { this.directory = directory; this.threshold = threshold; }
	append(text: string): void {
		if (this.closed || this.failed) return;
		this.pending += text;
		if (this.fd !== undefined || Buffer.byteLength(this.pending) > this.threshold) this.preserve();
	}
	/** Persist pending originals before any delivery/retention loss, even below the initial threshold. */
	preserve(): void {
		if (this.closed || this.failed || !this.pending) return;
		try {
			if (this.fd === undefined) {
				mkdirSync(this.directory, { recursive: true, mode: 0o700 });
				this.path = join(this.directory, `exec-${randomUUID()}.log`);
				this.fd = openSync(this.path, "wx", 0o600);
			}
			const buffer = Buffer.from(this.pending, "utf8");
			let offset = 0;
			while (offset < buffer.length) {
				const n = writeSync(this.fd, buffer, offset, buffer.length - offset);
				if (!n) throw new Error("output archive write made no progress");
				offset += n;
				this.bytes += n;
			}
			this.pending = "";
		} catch {
			// A failed archive is explicitly incomplete; never fail the command.
			this.failed = true;
			this.close();
		}
	}
	info() {
		if (this.failed && !this.path) return { fullOutputComplete: false, fullOutputError: "Output archive unavailable" };
		return this.path ? { fullOutputPath: this.path, fullOutputBytes: this.bytes, fullOutputComplete: !this.failed, fullOutputAppendOnly: true, ...(this.failed ? { fullOutputError: "Output archive is incomplete" } : {}) } : undefined;
	}
	close(): void {
		if (this.fd !== undefined) { try { closeSync(this.fd); } catch { this.failed = true; } }
		this.fd = undefined;
		this.closed = true;
		this.pending = "";
	}
}
