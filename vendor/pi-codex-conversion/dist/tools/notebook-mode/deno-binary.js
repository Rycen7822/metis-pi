var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { basename, join, resolve } from "node:path";
import { denoAssetUrl, DENO_VERSION, resolveDenoAsset } from "./deno-assets.js";
import { extractDenoArchive } from "./deno-archive.js";
import { acquireDirectoryLock } from "./directory-lock.js";
const DOWNLOAD_TIMEOUT_MS = 180_000;
const INSTALL_LOCK_TIMEOUT_MS = 185_000;
const INSTALL_LOCK_STALE_MS = 240_000;
const INSTALL_LOCK_POLL_MS = 200;
const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));
export async function ensureNotebookDenoBinary(overrides, signal) {
    const runtime = {
        platform: overrides.platform ?? process.platform,
        arch: overrides.arch ?? process.arch,
        agentDir: overrides.agentDir,
    };
    const asset = resolveDenoAsset(runtime.platform, runtime.arch);
    const destination = join(runtime.agentDir, "cache", "pi-codex-conversion", "notebook-mode", `deno-${DENO_VERSION}`, `${runtime.platform}-${runtime.arch}`, asset.executable);
    if (validDenoBinary(destination, asset.binarySha256, asset.binaryBytes))
        return destination;
    rmSync(destination, { force: true });
    await installDeno(destination, runtime, signal);
    if (!validDenoBinary(destination, asset.binarySha256, asset.binaryBytes)) {
        throw new Error(`Deno ${DENO_VERSION} cache validation failed after installation`);
    }
    return destination;
}
async function installDeno(destinationInput, runtime, signal) {
    const asset = resolveDenoAsset(runtime.platform, runtime.arch);
    const destination = resolve(destinationInput);
    if (basename(destination) !== asset.executable)
        throw new Error(`Deno destination must end with ${asset.executable}`);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    const lockPath = `${destination}.lock`;
    const lock = await acquireDirectoryLock(lockPath, {
        waitMs: INSTALL_LOCK_TIMEOUT_MS,
        staleMs: INSTALL_LOCK_STALE_MS,
        pollMs: INSTALL_LOCK_POLL_MS,
        signal,
        stopWaiting: () => existsSync(destination),
    });
    if (!lock)
        return;
    const staged = `${destination}.${process.pid}.tmp`;
    try {
        const url = denoAssetUrl(asset.archive);
        let bytes;
        try {
            const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
            const { getProxyForUrl } = await dynamicImport("proxy-from-env");
            const proxy = getProxyForUrl(url);
            const { ProxyAgent } = await dynamicImport("undici");
            const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
            try {
                const response = await globalThis.fetch(url, {
                    redirect: "follow",
                    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                    ...(dispatcher ? { dispatcher } : {}),
                });
                if (!response.ok)
                    throw new Error(`${response.status} ${response.statusText}`);
                bytes = await readPinnedResponse(response, asset.archiveBytes);
            }
            finally {
                await dispatcher?.close();
            }
        }
        catch (error) {
            throw new Error(`failed to download pinned Deno ${DENO_VERSION}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        const actualSha256 = createHash("sha256").update(bytes).digest("hex");
        if (actualSha256 !== asset.archiveSha256)
            throw new Error(`checksum mismatch for ${asset.archive}`);
        const binary = await extractDenoArchive(bytes, asset);
        signal?.throwIfAborted();
        if (binary.length !== asset.binaryBytes || createHash("sha256").update(binary).digest("hex") !== asset.binarySha256) {
            throw new Error("extracted Deno binary checksum mismatch");
        }
        writeFileSync(staged, binary, { mode: 0o755 });
        if (runtime.platform !== "win32")
            chmodSync(staged, 0o755);
        renameSync(staged, destination);
    }
    finally {
        rmSync(staged, { force: true });
        lock.release();
    }
}
async function readPinnedResponse(response, expectedBytes) {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== expectedBytes) {
        throw new Error(`pinned Deno archive size mismatch: expected ${expectedBytes} bytes, got ${declared}`);
    }
    if (!response.body)
        throw new Error("pinned Deno download had no response body");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > expectedBytes)
                throw new Error(`pinned Deno archive exceeds ${expectedBytes} bytes`);
            chunks.push(value);
        }
    }
    catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    if (total !== expectedBytes)
        throw new Error(`pinned Deno archive size mismatch: expected ${expectedBytes} bytes, got ${total}`);
    return Buffer.concat(chunks, total);
}
function validDenoBinary(path, expectedSha256, expectedBytes) {
    try {
        if (statSync(path).size !== expectedBytes)
            return false;
        return createHash("sha256").update(readFileSync(path)).digest("hex") === expectedSha256;
    }
    catch {
        return false;
    }
}
