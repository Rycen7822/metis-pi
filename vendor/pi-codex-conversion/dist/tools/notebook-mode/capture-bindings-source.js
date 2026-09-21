import { BINDING_METADATA_READER_SOURCE } from "./binding-metadata-source.js";
// Shared kernel-side value capture. Callers own their manifest schema and commit protocol.
// Binding references remain lexical (not globalThis lookups), so top-level let/const work.
export function captureBindingsSource(options, scope) {
    const captures = options.candidates.map((name) => `
  try {
    const __value = ${name};
    let __kind = "value";
    let __captured = __value;
    if (typeof __value === "function") {
      const __source = Function.prototype.toString.call(__value);
      if (__source.includes("[native code]")) throw new Error("native or bound function");
      const __candidate = (0, eval)("(" + __source + ")");
      if (typeof __candidate !== "function") throw new Error("function source did not reanimate");
      __kind = "function";
      __captured = __source;
    }
    if (__captured instanceof Promise) throw new Error("promise");
    if (__value instanceof WeakMap || __value instanceof WeakSet) throw new Error("weak collection");
    const __bytes = serialize(__captured);
    if (__bytes.byteLength > __max) throw new Error(${JSON.stringify(scope === "checkpoint" ? "exceeds per-variable checkpoint cap" : "exceeds per-value checkpoint cap")});
    if (__total + __bytes.byteLength > __max) throw new Error(${JSON.stringify(scope === "checkpoint" ? "exceeds total checkpoint cap" : "exceeds total project checkpoint cap")});
	const __metadata = __readBindingMetadata(__value);
	await __writeAll(__bytes);
	    __entries.push({
	      name: ${JSON.stringify(name)},
	      kind: __kind,
	      offset: __total,
	      length: __bytes.byteLength,
	      ...(__metadata.description === undefined ? {} : { description: __metadata.description }),
	      ...(__metadata.usage === undefined ? {} : { usage: __metadata.usage }),
	    });
    __total += __bytes.byteLength;
  } catch (__error) {
    __skipped.push({ name: ${JSON.stringify(name)}, reason: String(__error instanceof Error ? __error.message : __error).slice(0, 240) });
  }`).join("");
    return `
  const { serialize } = await import("node:v8");
  const __max = ${options.maxBytes};
	  const __entries = [];
	  const __skipped = ${JSON.stringify(scope === "checkpoint" ? options.skippedInvalid ?? [] : [])};
	  let __total = 0;
${BINDING_METADATA_READER_SOURCE}
	const __file = await Deno.open(${JSON.stringify(options.payloadPath)}, { create: true, write: true, truncate: true, mode: 0o600 });
	const __writeAll = async (__bytes) => {
	  let __offset = 0;
	  while (__offset < __bytes.byteLength) {
		const __written = await __file.write(__bytes.subarray(__offset));
		if (__written === 0) throw new Error(${JSON.stringify(scope === "checkpoint" ? "checkpoint payload write made no progress" : "project payload write made no progress")});
		__offset += __written;
	  }
	};
	try { ${captures} } finally { __file.close(); }
`;
}
