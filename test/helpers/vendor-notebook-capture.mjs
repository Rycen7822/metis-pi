// In-process stand-in for the capture half of the notebook kernel boundary: the shipped
// capture sources run under Node's v8 serializer and a Deno file stand-in, so tests observe
// real manifest/payload bytes without installing Deno (see vendor capture-bindings-source.js).
import { open, rename, rm, writeFile } from "node:fs/promises";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Deno version/file stand-in; `write(file, bytes)` observes or replaces a payload write. */
export function captureStandIn({ write, close } = {}) {
  return {
    version: { deno: "test-deno", v8: process.versions.v8 },
    async open(path) {
      const file = await open(path, "w", 0o600);
      return {
        async write(bytes) { return write ? write(file, bytes) : (await file.write(bytes)).bytesWritten; },
        close() { close?.(); return file.close(); },
      };
    },
    writeTextFile: (path, text) => writeFile(path, text, { mode: 0o600 }),
    rename,
    remove: (path) => rm(path),
  };
}

/** Run a real generated capture source. `names` defaults to the declared bindings the capture
 * source references; injected restore/marker sources take no bindings. */
export async function runCaptureSource(source, bindings, deno = captureStandIn(), names) {
  const params = names ?? [...new Set([...source.matchAll(/const __value = ([A-Za-z_$][A-Za-z0-9_$]*);/g)].map((match) => match[1]))];
  await new AsyncFunction("Deno", ...params, source)(deno, ...params.map((name) => bindings[name]));
}
