import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const MAX_RESIDENT_CHARS = 1024 * 1024;
const IO_CHUNK_CHARS = 64 * 1024;
/** A UTF-16 ring: retain the configured character budget without keeping it all on the heap. */
export class ExecOutputBuffer {
    startOffset = 0;
    endOffset = 0;
    memory = "";
    spool;
    spoolDisabled = false;
    failure;
    disposed = false;
    maxChars;
    constructor(maxChars) {
        this.maxChars = Math.max(1, Math.floor(maxChars));
    }
    get length() {
        return this.endOffset - this.startOffset;
    }
    append(text) {
        if (this.disposed || this.failure || text.length === 0)
            return;
        if (!this.spool && !this.spoolDisabled && Math.min(this.maxChars, this.length + text.length) > MAX_RESIDENT_CHARS) {
            this.openSpool();
        }
        const end = this.endOffset + text.length;
        const start = Math.max(this.startOffset, end - this.maxChars);
        const suffix = text.slice(Math.max(0, start - this.endOffset));
        if (this.spool) {
            try {
                this.writeRing(suffix, Math.max(start, this.endOffset));
            }
            catch {
                // Ring writes can only overwrite the prefix that this append evicts. The
                // retained old range is still recoverable, even after a partial write.
                try {
                    this.memory = this.readRange(Math.min(start, this.endOffset), this.endOffset) + suffix;
                }
                catch (error) {
                    this.fail(error);
                }
                this.closeSpool();
                this.spoolDisabled = true;
            }
        }
        else {
            this.memory = this.memory.slice(Math.min(start - this.startOffset, this.memory.length)) + suffix;
            if (start > this.startOffset)
                this.memory = Buffer.from(this.memory, "utf16le").toString("utf16le");
        }
        this.startOffset = start;
        this.endOffset = end;
        if (start > 0 && this.length > 0 && !this.failure) {
            try {
                if (/[\uDC00-\uDFFF]/.test(this.readRange(start, start + 1))) {
                    this.startOffset++;
                    if (!this.spool)
                        this.memory = this.memory.slice(1);
                }
            }
            catch (error) {
                this.fail(error);
            }
        }
    }
    /** String.slice semantics, but only the requested range is materialized. */
    slice(start = 0, end = this.length) {
        if (this.failure)
            throw this.failure;
        const relative = (offset) => {
            const integer = Math.trunc(offset) || 0;
            return integer < 0 ? Math.max(0, this.length + integer) : Math.min(this.length, integer);
        };
        const from = relative(start);
        const to = Math.max(from, relative(end));
        try {
            return this.readRange(this.startOffset + from, this.startOffset + to);
        }
        catch (error) {
            this.fail(error);
            throw this.failure;
        }
    }
    dispose() {
        this.disposed = true;
        this.memory = "";
        this.closeSpool();
    }
    openSpool() {
        let directory;
        try {
            directory = fs.mkdtempSync(join(tmpdir(), "pi-exec-output-"));
            this.spool = { directory, fd: fs.openSync(join(directory, "output"), "wx+", 0o600) };
            this.writeRing(this.memory, this.startOffset);
            this.memory = "";
        }
        catch {
            // A full/unwritable temp volume must not truncate output or stop a tool.
            // Fall back to the pre-existing in-memory retention budget for this session.
            this.closeSpool();
            if (directory)
                fs.rmSync(directory, { recursive: true, force: true });
            this.spoolDisabled = true;
        }
    }
    writeRing(text, offset) {
        const fd = this.spool.fd;
        for (let written = 0; written < text.length;) {
            const position = (offset + written) % this.maxChars;
            const count = Math.min(text.length - written, this.maxChars - position, IO_CHUNK_CHARS);
            const bytes = Buffer.from(text.slice(written, written + count), "utf16le");
            for (let done = 0; done < bytes.length;) {
                const size = fs.writeSync(fd, bytes, done, bytes.length - done, position * 2 + done);
                if (size === 0)
                    throw new Error("exec output spool write made no progress");
                done += size;
            }
            written += count;
        }
    }
    readRange(start, end) {
        if (!this.spool) {
            const text = this.memory.slice(start - this.startOffset, end - this.startOffset);
            // Detach small results/replay tails from a potentially large backing string.
            return Buffer.from(text, "utf16le").toString("utf16le");
        }
        const bytes = Buffer.allocUnsafe((end - start) * 2);
        for (let read = 0; read < bytes.length;) {
            const position = (start * 2 + read) % (this.maxChars * 2);
            const count = Math.min(bytes.length - read, this.maxChars * 2 - position);
            const size = fs.readSync(this.spool.fd, bytes, read, count, position);
            if (size === 0)
                throw new Error("exec output spool ended unexpectedly");
            read += size;
        }
        return bytes.toString("utf16le");
    }
    fail(error) {
        this.failure ??= new Error("Cannot recover exec output from its temporary spool", { cause: error });
        this.closeSpool();
        this.spoolDisabled = true;
        this.memory = "";
    }
    closeSpool() {
        const spool = this.spool;
        if (!spool)
            return;
        this.spool = undefined;
        try {
            fs.closeSync(spool.fd);
        }
        finally {
            fs.rmSync(spool.directory, { recursive: true, force: true });
        }
    }
}
