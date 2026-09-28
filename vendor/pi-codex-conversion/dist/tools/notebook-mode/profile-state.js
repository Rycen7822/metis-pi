import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, } from "node:fs";
import { join, resolve } from "node:path";
import { assertCandidateNames, captureNotebookCandidate, publishNotebookManifest, } from "./candidate-transaction.js";
import { withNotebookStateLock } from "./notebook-state-lock.js";
import { assertProfileName, assertSafeProfileDirectory, hashProfileBytes, PROFILE_STATE_SCHEMA, profilesDirectory, profileStatePaths, profileSummary, readProfileStateManifest, readProfileStatePayload, } from "./profile-state-format.js";
import { projectStateRestoreSource } from "./project-state-runtime.js";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export async function saveNotebookProfile(options) {
    assertProfileName(options.name);
    const paths = profileStatePaths(options.name, options.agentDir);
    assertSafeProfileDirectory(paths.directory, options.agentDir);
    mkdirSync(paths.directory, { recursive: true });
    const names = [...new Set(await options.kernel.complete("", 0, options.signal))]
        .filter((name) => IDENTIFIER.test(name) && !options.baselineNames.has(name))
        .sort();
    assertCandidateNames(names, "Notebook profile");
    const { candidate, payload } = await captureNotebookCandidate({
        directory: paths.directory,
        kernel: options.kernel,
        names,
        maxBytes: options.maxBytes,
        signal: options.signal,
        failureMessage: "Notebook profile capture failed",
        invalidMessage: "Notebook profile capture did not produce valid state",
    });
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
    await withNotebookStateLock(paths.lock, async () => {
        const previous = readProfileStateManifest(paths.manifest, manifest.name);
        const superseded = publishNotebookManifest({
            directory: paths.directory,
            manifestPath: paths.manifest,
            manifest,
            payloadName: manifest.payload,
            payload,
            previousPayload: previous?.payload,
            label: "Notebook profile",
        });
        if (superseded)
            rmSync(superseded, { force: true });
    }, options.signal);
    return profileSummary(manifest);
}
export async function loadNotebookProfile(options) {
    assertProfileName(options.name);
    const paths = profileStatePaths(options.name, options.agentDir);
    assertSafeProfileDirectory(paths.directory, options.agentDir);
    mkdirSync(paths.directory, { recursive: true });
    return withNotebookStateLock(paths.lock, async () => {
        const manifest = readProfileStateManifest(paths.manifest, options.name);
        if (!manifest)
            throw new Error(`Notebook profile not found or invalid: ${options.name}`);
        const payloadPath = join(paths.directory, manifest.payload);
        if (!readProfileStatePayload(manifest, payloadPath, options.maxBytes)) {
            throw new Error(`Notebook profile payload is missing or invalid: ${options.name}`);
        }
        const current = new Set((await options.kernel.complete("", 0, options.signal))
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
export class NotebookProfileRestoreError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "NotebookProfileRestoreError";
    }
}
