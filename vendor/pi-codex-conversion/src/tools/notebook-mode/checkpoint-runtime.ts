import { captureBindingsSource } from "./capture-bindings-source.ts";
import { BINDING_METADATA_RESTORE_SOURCE } from "./binding-metadata-source.ts";
import { CHECKPOINT_SCHEMA, type CheckpointManifest, type NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import { MAX_PROJECT_MANIFEST_BYTES } from "./project-state-format.ts";

export function checkpointSource(options: {
	candidates: string[];
	payloadPath: string;
	manifestPath: string;
	directory: string;
	identity: NotebookCheckpointIdentity;
	projectGeneration: string;
	projectNames: string[];
	payload: string;
	previousPayload?: string | undefined;
	skippedInvalid: Array<{ name: string; reason: string }>;
	maxBytes: number;
}): string {
	return `{
${captureBindingsSource(options, "checkpoint")}
  const __manifestPath = ${JSON.stringify(options.manifestPath)};
  const __previousPayload = ${JSON.stringify(options.previousPayload)};
  const __manifest = {
    schema: ${CHECKPOINT_SCHEMA},
    project: ${JSON.stringify(options.identity.project)},
	projectGeneration: ${JSON.stringify(options.projectGeneration)},
	projectNames: ${JSON.stringify(options.projectNames)},
    session: ${JSON.stringify(options.identity.session)},
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    payload: ${JSON.stringify(options.payload)},
    createdAt: new Date().toISOString(),
    entries: __entries,
    skipped: __skipped,
  };
  const __temporaryManifest = __manifestPath + "." + crypto.randomUUID() + ".tmp";
  const __manifestText = JSON.stringify(__manifest, null, 2) + "\\n";
  if (new TextEncoder().encode(__manifestText).byteLength > ${MAX_PROJECT_MANIFEST_BYTES}) {
    throw new Error("notebook checkpoint manifest exceeds ${MAX_PROJECT_MANIFEST_BYTES} bytes");
  }
  await Deno.writeTextFile(__temporaryManifest, __manifestText, { mode: 0o600 });
  await Deno.rename(__temporaryManifest, __manifestPath);
  if (__previousPayload && __previousPayload !== __manifest.payload) {
    await Deno.remove(${JSON.stringify(options.directory)} + "/" + __previousPayload).catch(() => {});
  }
  undefined;
}`;
}

export function restoreSource(manifest: CheckpointManifest, payloadPath: string, excludeNames: ReadonlySet<string> = new Set()): string {
	return `{
  const { deserialize } = await import("node:v8");
  if (Deno.version.deno !== ${JSON.stringify(manifest.deno)} || Deno.version.v8 !== ${JSON.stringify(manifest.v8)}) {
    throw new Error("checkpoint Deno/V8 version does not match the active kernel");
  }
  const __payload = await Deno.readFile(${JSON.stringify(payloadPath)});
	const __excluded = new Set(${JSON.stringify([...excludeNames])});
	const __entries = ${JSON.stringify(manifest.entries)}.filter(({ name }) => !__excluded.has(name));
	const __values = [];
	const __functions = [];
  for (const __entry of __entries) {
	const __captured = deserialize(__payload.slice(__entry.offset, __entry.offset + __entry.length));
	if (__entry.kind === "function") __functions.push([__entry.name, __captured, __entry]);
	else __values.push([__entry.name, __captured, __entry]);
	}
${BINDING_METADATA_RESTORE_SOURCE}
	for (const [__name, __value, __entry] of __values) {
	  __applyMetadata(__value, __entry);
	  Object.defineProperty(globalThis, __name, { value: __value, writable: true, configurable: true, enumerable: true });
	}
	for (const [__name, __source, __entry] of __functions) {
	  const __value = (0, eval)("(" + __source + ")");
	  __applyMetadata(__value, __entry);
	  Object.defineProperty(globalThis, __name, { value: __value, writable: true, configurable: true, enumerable: true });
	}
  undefined;
}`;
}
