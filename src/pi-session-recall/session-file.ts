import { createReadStream } from "node:fs";

/** Streams JSONL records without repeatedly flattening a growing long-line string. */
export async function* readSessionLines(path: string, signal?: AbortSignal): AsyncGenerator<string> {
	signal?.throwIfAborted();
	const stream = createReadStream(path, { encoding: "utf8", signal });
	const closed = new Promise<void>(resolve => stream.once("close", resolve));
	let parts: string[] = [];
	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			let start = 0;
			let end = chunk.indexOf("\n");
			while (end >= 0) {
				signal?.throwIfAborted();
				parts.push(chunk.slice(start, end));
				yield parts.join("").replace(/\r$/, "");
				parts = [];
				start = end + 1;
				end = chunk.indexOf("\n", start);
			}
			if (start < chunk.length) parts.push(chunk.slice(start));
		}
		if (parts.length) yield parts.join("").replace(/\r$/, "");
		signal?.throwIfAborted();
	} finally {
		stream.destroy();
		await closed;
	}
}
