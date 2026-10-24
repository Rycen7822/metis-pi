if (process.arch !== "x64" || !["linux", "win32"].includes(process.platform))
  throw new Error("Metis Neural Search builds support Linux x64 and Windows x64.");
const builder = new URL(`../src/neural-search/engine/build-${process.platform}-x64.mjs`, import.meta.url);
await import(builder.href);
