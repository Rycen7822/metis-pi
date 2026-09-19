const MAX_CELL_OUTPUT_CHARS = 32 * 1024 * 1024;
const MAX_CELL_OUTPUT_ITEMS = 10_000;
export class NotebookCell {
    id;
    source;
    controller = new AbortController();
    items = [];
    maxOutputTokens;
    context;
    result;
    terminated = false;
    outputChars = 0;
    outputTruncated = false;
    cursor = 0;
    completedValue = false;
    yielded = deferred();
    blockersChanged = deferred();
    blockers = new Set();
    completed = deferred();
    constructor(options) {
        this.id = options.id;
        this.source = options.source;
        this.context = options.context;
        this.maxOutputTokens = options.maxOutputTokens;
    }
    async observe(yieldTimeMs, signal) {
        signal?.throwIfAborted();
        while (!this.result) {
            const blockersChanged = this.blockersChanged.promise;
            const blocked = this.blockers.size > 0;
            await waitForObservation([
                this.completed.promise,
                blockersChanged,
                ...(blocked ? [] : [this.yielded.promise]),
            ], blocked ? undefined : yieldTimeMs, signal);
            if (this.result)
                return "result";
            if (this.blockersChanged.promise !== blockersChanged)
                continue;
            if (this.blockers.size > 0) {
                this.yielded = deferred();
                continue;
            }
            this.yielded = deferred();
            return "yielded";
        }
        return "result";
    }
    markCompleted() {
        this.completedValue = true;
        this.completed.resolve();
    }
    isCompleted() {
        return this.completedValue;
    }
    waitForCompletion() {
        return this.completed.promise;
    }
    requestYield() {
        this.yielded.resolve();
    }
    setBlocked(blockerId, active) {
        const changed = active ? !this.blockers.has(blockerId) : this.blockers.delete(blockerId);
        if (active)
            this.blockers.add(blockerId);
        if (!changed)
            return;
        if (active)
            this.yielded = deferred();
        this.blockersChanged.resolve();
        this.blockersChanged = deferred();
    }
    takeContent() {
        const content = this.items.slice(this.cursor);
        this.cursor = this.items.length;
        return content;
    }
    emit(items) {
        const accepted = [];
        for (const item of items) {
            if (this.outputTruncated)
                break;
            const size = item.type === "input_text" ? item.text?.length ?? 0 : item.image_url?.length ?? 0;
            if (this.items.length >= MAX_CELL_OUTPUT_ITEMS || this.outputChars + size > MAX_CELL_OUTPUT_CHARS) {
                const notice = { type: "input_text", text: "[Notebook cell output truncated]" };
                this.items.push(notice);
                accepted.push(notice);
                this.outputChars += notice.text.length;
                this.outputTruncated = true;
                break;
            }
            this.items.push(item);
            accepted.push(item);
            this.outputChars += size;
        }
        const content = [];
        for (const item of accepted) {
            if (item.type === "input_text" && item.text) {
                content.push({ type: "text", text: item.text });
                continue;
            }
            const match = item.type === "input_image" && item.image_url?.match(/^data:([^;,]+);base64,(.+)$/s);
            if (match)
                content.push({ type: "image", mimeType: match[1], data: match[2] });
        }
        if (content.length > 0)
            this.context.onUpdate?.({ content, details: { cellId: this.id, status: "running" } });
    }
}
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
function waitForObservation(promises, timeoutMs, signal) {
    if (signal?.aborted)
        return Promise.reject(signal.reason ?? new Error("Operation aborted"));
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const abort = () => finish(signal?.reason ?? new Error("Operation aborted"));
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error === undefined)
                resolve();
            else
                reject(error);
        };
        for (const promise of promises)
            void promise.then(() => finish(), (error) => finish(error));
        if (timeoutMs !== undefined)
            timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
        signal?.addEventListener("abort", abort, { once: true });
    });
}
