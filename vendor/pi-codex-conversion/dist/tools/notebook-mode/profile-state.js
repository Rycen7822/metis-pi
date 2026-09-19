import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { join, resolve } from "node:path";
import { acquireDirectoryLock } from "./directory-lock.js";
import { assertProfileName, assertSafeProfileDirectory, hashProfileBytes, PROFILE_STATE_SCHEMA, profilesDirectory, profileStatePaths, profileSummary, readProfileStateManifest, readProfileStatePayload, } from "./profile-state-format.js";
import { MAX_PROJECT_ENTRIES, MAX_PROJECT_MANIFEST_BYTES, MAX_PROJECT_NAME_BYTES, readProjectStateCandidate, } from "./project-state-format.js";
import { projectStateCaptureSource, projectStateRestoreSource } from "./project-state-runtime.js";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 5_000;
export async function saveNotebookProfile(options) {
    assertProfileName(options.name);
    const paths = profileStatePaths(options.name, options.agentDir);
    assertSafeProfileDirectory(paths.directory, options.agentDir);
    mkdirSync(paths.directory, { recursive: true });
    const id = randomUUID();
    const candidatePayload = join(paths.directory, `candidate-${id}.bin`);
    const candidateManifest = join(paths.directory, `candidate-${id}.json`);
    try {
        const names = [...new Set(await options.kernel.complete("", 0, options.signal))]
            .filter((name) => IDENTIFIER.test(name) && !options.baselineNames.has(name))
            .sort();
        if (names.length > MAX_PROJECT_ENTRIES)
            throw new Error(`Notebook profile exceeds ${MAX_PROJECT_ENTRIES} top-level values`);
        if (names.some((name) => Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES)) {
            throw new Error(`Notebook profile name exceeds ${MAX_PROJECT_NAME_BYTES} bytes`);
        }
        const capture = await options.kernel.execute(projectStateCaptureSource({
            candidates: names,
            payloadPath: candidatePayload,
            manifestPath: candidateManifest,
            maxBytes: options.maxBytes,
        }), { signal: options.signal });
        if (capture.status !== "ok")
            throw new Error(`Notebook profile capture failed: ${capture.errorText ?? "unknown error"}`);
        const candidate = readProjectStateCandidate(candidateManifest, candidatePayload, options.maxBytes);
        if (!candidate)
            throw new Error("Notebook profile capture did not produce valid state");
        const payload = readFileSync(candidatePayload);
        const generation = randomUUID();
        const payloadName = `profile-${generation}.bin`;
        const manifest = {
            schema: PROFILE_STATE_SCHEMA,
            name: options.name,
            deno: candidate.deno,
            v8: candidate.v8,
            payload: payloadName,
            createdAt: new Date().toISOString(),
            sourceProject: resolve(options.project),
            entries: candidate.entries.map((entry) => ({
                ...entry,
                hash: hashProfileBytes(payload.subarray(entry.offset, entry.offset + entry.length)),
            })),
            skipped: candidate.skipped,
        };
        await withProfileLock(paths.lock, async () => writeProfile(paths, manifest, payload), options.signal);
        return profileSummary(manifest);
    }
    finally {
        rmSync(candidatePayload, { force: true });
        rmSync(candidateManifest, { force: true });
    }
}
export async function loadNotebookProfile(options) {
    assertProfileName(options.name);
    const paths = profileStatePaths(options.name, options.agentDir);
    assertSafeProfileDirectory(paths.directory, options.agentDir);
    mkdirSync(paths.directory, { recursive: true });
    return withProfileLock(paths.lock, async () => {
        const manifest = readProfileStateManifest(paths.manifest, options.name);
        if (!manifest)
            throw new Error(`Notebook profile not found or invalid: ${options.name}`);
        const payloadPath = join(paths.directory, manifest.payload);
        if (!readProfileStatePayload(manifest, payloadPath, options.maxBytes)) {
            throw new Error(`Notebook profile payload is missing or invalid: ${options.name}`);
        }
        const current = new Set([...new Set(await options.kernel.complete("", 0, options.signal))]
            .filter((name) => IDENTIFIER.test(name) && !options.baselineNames.has(name)));
        const collisions = manifest.entries.map(({ name }) => name).filter((name) => current.has(name));
        if (collisions.length > 0)
            return { summary: profileSummary(manifest), loaded: [], collisions };
        let restored;
        try {
            restored = await options.kernel.execute(projectStateRestoreSource(manifest, payloadPath), { signal: options.signal });
        }
        catch (error) {
            throw new NotebookProfileRestoreError(`Notebook profile could not be loaded: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        if (restored.status !== "ok")
            throw new NotebookProfileRestoreError(`Notebook profile could not be loaded: ${restored.errorText ?? "unknown error"}`);
        return {
            summary: profileSummary(manifest),
            loaded: manifest.entries.map(({ name }) => name),
            collisions: [],
        };
    }, options.signal);
}
export function listNotebookProfiles(agentDir) {
    let names;
    try {
        names = readdirSync(profilesDirectory(agentDir));
    }
    catch {
        return [];
    }
    return names.flatMap((name) => {
        try {
            const paths = profileStatePaths(name, agentDir);
            assertSafeProfileDirectory(paths.directory, agentDir);
            const manifest = readProfileStateManifest(paths.manifest, name);
            return manifest ? [profileSummary(manifest)] : [];
        }
        catch {
            return [];
        }
    }).sort((left, right) => left.name.localeCompare(right.name));
}
export function notebookProfileBindingNames(name, agentDir, maxBytes) {
    if (!name)
        return [];
    try {
        const paths = profileStatePaths(name, agentDir);
        assertSafeProfileDirectory(paths.directory, agentDir);
        const manifest = readProfileStateManifest(paths.manifest, name);
        return manifest && readProfileStatePayload(manifest, join(paths.directory, manifest.payload), maxBytes)
            ? manifest.entries.map((entry) => entry.name)
            : [];
    }
    catch {
        return [];
    }
}
function writeProfile(paths, manifest, payload) {
    const previous = readProfileStateManifest(paths.manifest, manifest.name);
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_PROJECT_MANIFEST_BYTES)
        throw new Error(`Notebook profile manifest exceeds ${MAX_PROJECT_MANIFEST_BYTES} bytes`);
    writeFileSync(join(paths.directory, manifest.payload), payload, { mode: 0o600 });
    const temporary = `${paths.manifest}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, paths.manifest);
    if (previous?.payload && previous.payload !== manifest.payload)
        rmSync(join(paths.directory, previous.payload), { force: true });
}
export class NotebookProfileRestoreError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "NotebookProfileRestoreError";
    }
}
async function withProfileLock(path, operation, signal) {
    const lock = await acquireDirectoryLock(path, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, pollMs: 50, signal });
    if (!lock)
        throw new Error("Notebook profile lock became unavailable");
    try {
        return await operation();
    }
    finally {
        lock.release();
    }
}
