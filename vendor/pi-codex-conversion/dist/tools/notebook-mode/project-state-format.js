import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
export const PROJECT_STATE_SCHEMA = 2;
export const MAX_PROJECT_ENTRIES = 10_000;
export const MAX_PROJECT_NAME_BYTES = 4 * 1024;
export const MAX_PROJECT_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_DESCRIPTION_BYTES = 256;
export const MAX_PROJECT_USAGE_BYTES = 512;
export const MAX_PROJECT_USAGE_LINES = 4;
const PAYLOAD_NAME = /^project-[0-9a-f-]+\.bin$/;
const CONFLICT_PAYLOAD_NAME = /^[0-9]+-[0-9a-f-]+\.bin$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export function projectStatePaths(project, agentDir) {
    const key = createHash("sha256").update(resolve(project)).digest("hex");
    const directory = join(agentDir, "cache", "pi-codex-conversion", "notebook-mode", "projects", key);
    return { directory, manifest: join(directory, "project.json"), lock: join(directory, "write.lock") };
}
export function readProjectStateManifest(path) {
    try {
        if (statSync(path).size > MAX_PROJECT_MANIFEST_BYTES)
            return undefined;
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (!isRecord(value) || value["schema"] !== PROJECT_STATE_SCHEMA)
            return undefined;
        if (typeof value["project"] !== "string"
            || typeof value["generation"] !== "string"
            || typeof value["deno"] !== "string"
            || typeof value["v8"] !== "string"
            || typeof value["payload"] !== "string"
            || typeof value["createdAt"] !== "string"
            || !Number.isFinite(Date.parse(value["createdAt"]))
            || typeof value["sourceSession"] !== "string"
            || !Array.isArray(value["entries"])
            || !Array.isArray(value["skipped"])
            || !PAYLOAD_NAME.test(value["payload"])
            || basename(value["payload"]) !== value["payload"]
            || value["entries"].length > MAX_PROJECT_ENTRIES
            || value["skipped"].length > MAX_PROJECT_ENTRIES)
            return undefined;
        const entries = value["entries"].map((entry) => parseEntry(entry, Number.MAX_SAFE_INTEGER, true));
        const skipped = value["skipped"].map(parseSkippedBinding);
        if (entries.some((entry) => !entry) || skipped.some((entry) => !entry))
            return undefined;
        return {
            schema: PROJECT_STATE_SCHEMA,
            project: value["project"],
            generation: value["generation"],
            ...(typeof value["parentGeneration"] === "string" ? { parentGeneration: value["parentGeneration"] } : {}),
            deno: value["deno"],
            v8: value["v8"],
            payload: value["payload"],
            createdAt: value["createdAt"],
            sourceSession: value["sourceSession"],
            entries: entries,
            skipped: skipped,
        };
    }
    catch {
        return undefined;
    }
}
export function readProjectStateCandidate(manifestPath, payloadPath, maxBytes) {
    try {
        if (statSync(manifestPath).size > MAX_PROJECT_MANIFEST_BYTES)
            return undefined;
        const value = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (!isRecord(value) || typeof value["deno"] !== "string" || typeof value["v8"] !== "string")
            return undefined;
        if (!Array.isArray(value["entries"]) || !Array.isArray(value["skipped"]))
            return undefined;
        if (value["entries"].length > MAX_PROJECT_ENTRIES || value["skipped"].length > MAX_PROJECT_ENTRIES)
            return undefined;
        const payloadLength = statSync(payloadPath).size;
        if (payloadLength > maxBytes)
            return undefined;
        const entries = value["entries"].map((entry) => parseEntry(entry, payloadLength, false));
        const skipped = value["skipped"].map(parseSkippedBinding);
        if (entries.some((entry) => !entry) || skipped.some((entry) => !entry))
            return undefined;
        return {
            deno: value["deno"],
            v8: value["v8"],
            entries: entries,
            skipped: skipped,
        };
    }
    catch {
        return undefined;
    }
}
export function readProjectStatePayload(manifest, path, maxBytes) {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
            return undefined;
        const payload = readFileSync(path);
        const names = new Set();
        let offset = 0;
        for (const entry of manifest.entries) {
            if (names.has(entry.name) || entry.offset !== offset || entry.offset + entry.length > payload.length)
                return undefined;
            names.add(entry.name);
            if (hashStateBytes(payload.subarray(entry.offset, entry.offset + entry.length)) !== entry.hash)
                return undefined;
            offset += entry.length;
        }
        return offset === payload.length ? payload : undefined;
    }
    catch {
        return undefined;
    }
}
export function readProjectConflictRecord(path) {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_MANIFEST_BYTES)
            return undefined;
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (!isRecord(value) || value["schema"] !== PROJECT_STATE_SCHEMA)
            return undefined;
        if (!Array.isArray(value["entries"]) || !Array.isArray(value["deletions"]))
            return undefined;
        if (value["entries"].length > MAX_PROJECT_ENTRIES || value["deletions"].length > MAX_PROJECT_ENTRIES)
            return undefined;
        const names = [
            ...value["entries"].map((entry) => isRecord(entry) ? entry["name"] : undefined),
            ...value["deletions"],
        ];
        if (names.some((name) => typeof name !== "string" || !IDENTIFIER.test(name) || Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES)) {
            return undefined;
        }
        const payload = value["payload"];
        const recordId = basename(path, ".json");
        if (payload !== undefined && (typeof payload !== "string"
            || !CONFLICT_PAYLOAD_NAME.test(payload)
            || basename(payload) !== payload
            || payload !== `${recordId}.bin`))
            return undefined;
        return { names: [...new Set(names)], ...(typeof payload === "string" ? { payload } : {}) };
    }
    catch {
        return undefined;
    }
}
export function baselineFromProjectManifest(manifest) {
    return {
        generation: manifest.generation,
        entries: manifest.entries.map(({ name, hash, description, usage }) => ({
            name,
            hash,
            ...(description === undefined ? {} : { description }),
            ...(usage === undefined ? {} : { usage }),
        })),
    };
}
export function emptyProjectStateSummary() {
    return { baseline: { generation: "root", entries: [] }, restored: [], skipped: [], conflicts: [] };
}
export function hashStateBytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function parseEntry(value, payloadLength, requireHash) {
    if (!isRecord(value))
        return undefined;
    const { name, kind, offset, length, hash, updatedAt, pinned } = value;
    if (typeof name !== "string" || !IDENTIFIER.test(name) || Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES
        || kind !== "value" && kind !== "function"
        || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(length) || length < 0
        || offset + length > payloadLength
        || requireHash && typeof hash !== "string"
        || updatedAt !== undefined && (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)))
        || pinned !== undefined && pinned !== true)
        return undefined;
    const metadata = parseProjectBindingMetadata(value);
    if (!metadata)
        return undefined;
    const entry = {
        name,
        kind: kind,
        offset: offset,
        length: length,
        ...metadata,
        ...(typeof updatedAt === "string" ? { updatedAt } : {}),
        ...(pinned === true ? { pinned: true } : {}),
    };
    return requireHash ? { ...entry, hash: hash } : entry;
}
export function parseProjectBindingMetadata(value) {
    const description = parseMetadataText(value["description"], MAX_PROJECT_DESCRIPTION_BYTES, false);
    const usage = parseMetadataText(value["usage"], MAX_PROJECT_USAGE_BYTES, true);
    if (description === null || usage === null)
        return undefined;
    return {
        ...(description === undefined ? {} : { description }),
        ...(usage === undefined ? {} : { usage }),
    };
}
function parseMetadataText(value, maxBytes, multiline) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes)
        return null;
    const lines = value.split("\n");
    if ((!multiline && lines.length !== 1) || lines.length > MAX_PROJECT_USAGE_LINES || value.includes("\r"))
        return null;
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint < 0x20 && codePoint !== 0x0a || codePoint === 0x7f)
            return null;
    }
    return value;
}
export function parseSkippedBinding(value) {
    return isRecord(value)
        && typeof value["name"] === "string"
        && Buffer.byteLength(value["name"]) <= MAX_PROJECT_NAME_BYTES
        && typeof value["reason"] === "string"
        ? { name: value["name"], reason: value["reason"] }
        : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function hasPayloadLayout(entries, path, maxBytes) {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
            return false;
        let offset = 0;
        const names = new Set();
        for (const entry of entries) {
            if (names.has(entry.name) || entry.offset !== offset)
                return false;
            names.add(entry.name);
            offset += entry.length;
        }
        return offset === stat.size;
    }
    catch {
        return false;
    }
}
