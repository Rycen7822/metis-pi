import {
  loadWebAccessConfig,
  webCredentialsPath,
  webPreferencesPath
} from "./chunk-U3C4JCC5.js";

// src/pi-web-access/proxy-transport.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebAccessConfig, webAccessAgentDir } from "../../configuration/web-access.ts";

// src/pi-web-access/hostname.ts
import { isIP } from "node:net";
function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}
function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "::1" || isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127";
}

// src/pi-web-access/proxy-transport.ts
var proxyStorage = new AsyncLocalStorage();
function normalizeProxyUrl(value, source) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw new Error(`${source} must be an http(s) or socks proxy URL string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${source} must be a valid proxy URL: ${JSON.stringify(trimmed)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks4:" && parsed.protocol !== "socks4a:" && parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") {
    throw new Error(`${source} must use the http://, https://, or socks scheme: ${trimmed}`);
  }
  if (!parsed.hostname) throw new Error(`${source} must include a proxy host: ${trimmed}`);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}
function redactProxyUrl(value) {
  const parsed = new URL(value);
  if (parsed.username) parsed.username = "redacted";
  if (parsed.password) parsed.password = "redacted";
  return parsed.toString();
}
function loadConfiguredProxy() {
  const configured = readWebAccessConfig(webAccessAgentDir()).proxy;
  if (configured === void 0) return null;
  return normalizeProxyUrl(configured, "webAccess.proxy");
}
function runWithProxy(proxy, fn) {
  if (proxy === void 0) {
    const configured = loadConfiguredProxy();
    if (configured === null) return fn();
    return proxyStorage.run(configured, fn);
  }
  const normalized = normalizeProxyUrl(proxy, "proxy");
  return proxyStorage.run(normalized, fn);
}
function noProxyEntryMatches(hostname, port, entry) {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  let host = trimmed;
  let entryPort;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close < 0) return false;
    const suffix2 = host.slice(close + 1);
    if (suffix2 && !/^:\d+$/.test(suffix2)) return false;
    if (suffix2) entryPort = suffix2.slice(1);
    host = host.slice(0, close + 1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon > -1 && /^\d+$/.test(host.slice(colon + 1))) {
      entryPort = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
  }
  if (entryPort !== void 0 && entryPort !== port) return false;
  host = normalizeHostname(host);
  if (!host) return false;
  if (hostname === host) return true;
  const suffix = host.startsWith("*.") ? host.slice(1) : host.startsWith(".") ? host : `.${host}`;
  return hostname.endsWith(suffix);
}
function isProxyBypassedUrl(url) {
  const hostname = normalizeHostname(url.hostname);
  if (isLoopbackHostname(hostname) || hostname.endsWith(".localhost")) return true;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  return Boolean(noProxy && noProxy.split(",").some((entry) => noProxyEntryMatches(hostname, port, entry)));
}
function resolveWebProxy(url, explicitProxy) {
  const configured = loadConfiguredProxy();
  const scoped = proxyStorage.getStore();
  let proxy = explicitProxy !== void 0 ? normalizeProxyUrl(explicitProxy, "proxy") : scoped !== void 0 ? scoped : configured;
  let environment = false;
  if (proxy === null && explicitProxy === void 0 && scoped === void 0 && configured === null) {
    const candidates = url.protocol === "https:" ? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy] : [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy];
    for (const candidate of candidates) {
      if (!candidate?.trim()) continue;
      try {
        proxy = normalizeProxyUrl(candidate, "proxy environment");
      } catch {
        continue;
      }
      if (proxy) {
        environment = true;
        break;
      }
    }
  }
  if (isProxyBypassedUrl(url)) proxy = null;
  return {
    proxy,
    operatorControlled: proxy !== null && (environment || proxy === configured),
    remoteDns: proxy !== null && ["http:", "https:", "socks4a:", "socks5h:"].includes(new URL(proxy).protocol)
  };
}
async function webFetch(input, init, nativeFetch = globalThis.fetch) {
  let url = null;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "http:" && url.protocol !== "https:") {
    return nativeFetch(input, init);
  }
  if (init?.__validated && init.__validated.url !== url.toString()) throw new Error("Validated route belongs to a different URL");
  const proxy = init?.__validated ? init.__validated.proxy : resolveWebProxy(url, init?.__proxy).proxy;
  if (!proxy) return nativeFetch(input, init);
  if (input instanceof Request) {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.body === null ? null : new Uint8Array(await new Response(
      request.body.pipeThrough(new TransformStream(), { signal: request.signal })
    ).arrayBuffer());
    init = { ...init, method: request.method, headers: request.headers, body, signal: request.signal, redirect: request.redirect };
  }
  return fetchViaCurl(url, init ?? {}, proxy);
}
function parseHeaderDump(dump, keepLengthHeaders) {
  const blocks = dump.split(/\r?\n\r?\n/).filter((block2) => /^HTTP\/[\d.]+\s+\d{3}/.test(block2.trim()));
  const block = (blocks.length > 0 ? blocks[blocks.length - 1] : "").trim();
  const lines = block.split(/\r?\n/);
  let status = 0;
  let statusText = "";
  const headers = [];
  for (const line of lines) {
    const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(line.trim());
    if (match) {
      status = Number(match[1]);
      statusText = match[2] ?? "";
      headers.length = 0;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator > 0) {
      const name = line.slice(0, separator).trim();
      if (!keepLengthHeaders && (name.toLowerCase() === "content-encoding" || name.toLowerCase() === "content-length")) continue;
      headers.push([name, line.slice(separator + 1).trim()]);
    }
  }
  return { status, statusText, headers };
}
var CurlTransportError = class extends Error {
};
function curlConfigValue(value) {
  return `"${value.replace(/[\\"\t\n\r\v]/g, (character) => ({
    "\\": "\\\\",
    '"': '\\"',
    "	": "\\t",
    "\n": "\\n",
    "\r": "\\r",
    "\v": "\\v"
  })[character])}"`;
}
async function fetchViaCurl(url, init, proxyUrl) {
  let current = url;
  let currentInit = init;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchViaCurlOnce(current, currentInit, proxyUrl);
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects > 0) Object.defineProperty(response, "redirected", { value: true, configurable: true });
      return response;
    }
    if (currentInit.redirect === "manual") return response;
    if (currentInit.redirect === "error") throw new TypeError(`Proxy fetch redirect blocked from ${current.toString()}`);
    if (redirects === 20) throw new Error(`Too many proxy redirects from ${url.toString()}`);
    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error(`Proxy redirect from ${current.origin} must use HTTP(S)`);
    let headers = new Headers(currentInit.headers);
    let nextInit;
    const method = currentInit.method?.toUpperCase() ?? "GET";
    if ((response.status === 301 || response.status === 302) && method === "POST" || response.status === 303 && method !== "GET" && method !== "HEAD") {
      for (const name of ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"]) headers.delete(name);
      const { body: _body, ...withoutBody } = currentInit;
      nextInit = { ...withoutBody, method: "GET", headers };
    } else {
      nextInit = { ...currentInit, headers };
    }
    if (next.origin !== current.origin) {
      headers = new Headers();
      nextInit = { ...nextInit, headers };
    }
    current = next;
    currentInit = nextInit;
  }
}
async function fetchViaCurlOnce(url, init, proxyUrl) {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const dir = await mkdtemp(join(tmpdir(), "pi-web-access-proxy-"));
  const headerFile = join(dir, "headers");
  const bodyFile = join(dir, "body");
  const requestBodyFile = join(dir, "request-body");
  const args = [
    "--disable",
    "--silent",
    "--show-error",
    "--compressed",
    "--connect-timeout",
    "20",
    "-D",
    headerFile,
    "--output",
    bodyFile,
    "--write-out",
    "%{json}",
    "--config",
    "-"
  ];
  const config = [`proxy = ${curlConfigValue(proxyUrl)}`, `noproxy = ""`, `url = ${curlConfigValue(url.toString())}`];
  const addresses = init.__validated?.addresses;
  if (addresses?.length) {
    const address = addresses[0].address;
    const target = address.includes(":") ? `[${address}]` : address;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    config.push(`connect-to = ${curlConfigValue(`${url.hostname}:${port}:${target}:${port}`)}`);
  }
  if (method === "HEAD") args.push("--head");
  else if (method !== "GET") args.push("-X", method);
  for (const [name, value] of headers.entries()) {
    if (value === "") continue;
    config.push(`header = ${curlConfigValue(`${name}: ${value}`)}`);
  }
  const body = init.body;
  if (body !== void 0 && body !== null) {
    let buffer;
    if (typeof body === "string") buffer = Buffer.from(body, "utf-8");
    else if (body instanceof URLSearchParams) buffer = Buffer.from(body.toString(), "utf-8");
    else if (body instanceof ArrayBuffer) buffer = Buffer.from(body);
    else if (ArrayBuffer.isView(body)) buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else throw new Error(`Unsupported request body type for proxy fetch: ${typeof body}`);
    await writeFile(requestBodyFile, buffer, { mode: 384 });
    args.push("--data-binary", `@${requestBodyFile}`);
    if (method === "GET") args.push("-X", "GET");
  } else if ((method === "POST" || method === "PUT") && !headers.has("content-length")) {
    config.push(`header = ${curlConfigValue("Content-Length: 0")}`);
  }
  const signal = init.signal ?? null;
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const child = spawn("curl", args, { windowsHide: true });
      let out = "";
      let stderr = "";
      const onAbort = () => {
        try {
          child.kill();
        } catch {
        }
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf-8");
      });
      child.stdin?.on("error", (err) => {
        if (err.code !== "EPIPE") reject(new CurlTransportError(`curl configuration pipe failed: ${err.message}`));
      });
      child.once("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(new CurlTransportError(err.code === "ENOENT" ? "curl executable not found on PATH; proxy transport requires curl" : `curl failed to start: ${err.message}`));
      });
      child.once("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return reject(new DOMException("The operation was aborted.", "AbortError"));
        if (code !== 0) {
          const pinHint = addresses?.length && ["http:", "https:"].includes(new URL(proxyUrl).protocol) && /CONNECT/i.test(stderr) ? ". Strict DNS pinning requires CONNECT support; for an operator-controlled remote-DNS proxy, set ssrf.trustEnvProxy=true." : "";
          return reject(new CurlTransportError(`curl exited with code ${code ?? "unknown"} via ${redactProxyUrl(proxyUrl)}${stderr.trim() ? `: ${stderr.trim()}` : ""}${pinHint}`));
        }
        resolve(out);
      });
      child.stdin?.end(`${config.join("\n")}
`);
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {
    });
    if (err instanceof CurlTransportError) throw new Error(err.message);
    throw err;
  }
  let bodyBuffer = Buffer.alloc(0);
  let dump = "";
  try {
    [dump, bodyBuffer] = await Promise.all([readFile(headerFile, "utf-8"), readFile(bodyFile)]);
  } catch {
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
    });
  }
  const { status, statusText, headers: responseHeaders } = parseHeaderDump(dump, method === "HEAD");
  if (status === 0) {
    throw new Error(`Proxy fetch to ${url.toString()} via ${redactProxyUrl(proxyUrl)} returned no HTTP status`);
  }
  let finalUrl = url.toString();
  let redirected = false;
  try {
    const trimmed = stdout.trim();
    if (trimmed.startsWith("{")) {
      const writeOut = JSON.parse(trimmed);
      if (writeOut.url_effective) finalUrl = writeOut.url_effective;
      redirected = (writeOut.num_redirects ?? 0) > 0;
    }
  } catch {
  }
  const nullBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
  const response = new Response(nullBody ? null : new Uint8Array(bodyBuffer), {
    status,
    statusText: statusText || void 0,
    headers: new Headers(responseHeaders)
  });
  Object.defineProperty(response, "url", { value: finalUrl, configurable: true });
  Object.defineProperty(response, "redirected", { value: redirected, configurable: true });
  return response;
}

// src/pi-web-access/activity.ts
var ActivityMonitor = class {
  entries = [];
  maxEntries = 10;
  listeners = /* @__PURE__ */ new Set();
  rateLimitInfo = { used: 0, max: 10, oldestTimestamp: null, windowMs: 6e4 };
  nextId = 1;
  logStart(partial) {
    const id = `act-${this.nextId++}`;
    const entry = {
      ...partial,
      id,
      startTime: Date.now(),
      status: null
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.notify();
    return id;
  }
  logComplete(id, status) {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.endTime = Date.now();
      entry.status = status;
      this.notify();
    }
  }
  logError(id, error) {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.endTime = Date.now();
      entry.error = error;
      this.notify();
    }
  }
  getEntries() {
    return this.entries;
  }
  getRateLimitInfo() {
    return this.rateLimitInfo;
  }
  updateRateLimit(info) {
    this.rateLimitInfo = info;
    this.notify();
  }
  onUpdate(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  clear() {
    this.entries = [];
    this.rateLimitInfo = { used: 0, max: 10, oldestTimestamp: null, windowMs: 6e4 };
    this.notify();
  }
  notify() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
      }
    }
  }
};
var activityMonitor = new ActivityMonitor();

// src/pi-web-access/github-extract.ts
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { lstat as lstatAsync, open as openAsync, opendir as opendirAsync, readFile as readFileAsync, realpath as realpathAsync, rm as rmAsync } from "node:fs/promises";
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join as join2, resolve as resolvePath, sep as pathSep } from "node:path";

// src/pi-web-access/github-api.ts
import { execFile } from "node:child_process";
var MAX_TREE_ENTRIES = 200;
var MAX_INLINE_FILE_CHARS = 1e5;
var ghAvailable = null;
var ghHintShown = false;
async function checkGhAvailable(signal) {
  if (ghAvailable !== null) return ghAvailable;
  return new Promise((resolve) => {
    execFile("gh", ["--version"], { timeout: 5e3, ...signal ? { signal } : {} }, (err) => {
      const available = !err;
      if (!signal?.aborted) ghAvailable = available;
      resolve(available);
    });
  });
}
function showGhHint() {
  if (!ghHintShown) {
    ghHintShown = true;
    console.error("[pi-web-access] Install `gh` CLI for better GitHub repo access including private repos.");
  }
}
async function checkRepoSize(owner, repo) {
  if (!await checkGhAvailable()) return null;
  return new Promise((resolve) => {
    execFile("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".size"], { timeout: 1e4 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const kb = parseInt(stdout.trim(), 10);
      resolve(Number.isNaN(kb) ? null : kb);
    });
  });
}
async function getDefaultBranch(owner, repo) {
  if (!await checkGhAvailable()) return null;
  return new Promise((resolve) => {
    execFile("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"], { timeout: 1e4 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const branch = stdout.trim();
      resolve(branch || null);
    });
  });
}
async function fetchTreeViaApi(owner, repo, ref) {
  if (!await checkGhAvailable()) return null;
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"],
      { timeout: 15e3, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const paths = stdout.trim().split("\n").filter(Boolean);
        if (paths.length === 0) {
          resolve(null);
          return;
        }
        const truncated = paths.length > MAX_TREE_ENTRIES;
        const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
        resolve(truncated ? display + `
... (${paths.length} total entries)` : display);
      }
    );
  });
}
async function fetchReadmeViaApi(owner, repo, ref) {
  if (!await checkGhAvailable()) return null;
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
      { timeout: 1e4 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
          resolve(decoded.length > 8192 ? decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : decoded);
        } catch {
          resolve(null);
        }
      }
    );
  });
}
async function fetchFileViaApi(owner, repo, path, ref) {
  if (!await checkGhAvailable()) return null;
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
      { timeout: 1e4, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          resolve(Buffer.from(stdout.trim(), "base64").toString("utf-8"));
        } catch {
          resolve(null);
        }
      }
    );
  });
}
async function fetchViaApi(url, owner, repo, info, sizeNote) {
  const ref = info.ref || await getDefaultBranch(owner, repo);
  if (!ref) return null;
  const lines = [];
  if (sizeNote) {
    lines.push(sizeNote);
    lines.push("");
  }
  if (info.type === "blob" && info.path) {
    const content = await fetchFileViaApi(owner, repo, info.path, ref);
    if (!content) return null;
    lines.push(`## ${info.path}`);
    if (content.length > MAX_INLINE_FILE_CHARS) {
      lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
      lines.push(`
[File truncated at 100K chars]`);
    } else {
      lines.push(content);
    }
    return {
      url,
      title: `${owner}/${repo} - ${info.path}`,
      content: lines.join("\n"),
      error: null
    };
  }
  const [tree, readme] = await Promise.all([
    fetchTreeViaApi(owner, repo, ref),
    fetchReadmeViaApi(owner, repo, ref)
  ]);
  if (!tree && !readme) return null;
  if (tree) {
    lines.push("## Structure");
    lines.push(tree);
    lines.push("");
  }
  if (readme) {
    lines.push("## README.md");
    lines.push(readme);
    lines.push("");
  }
  lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");
  const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
  return {
    url,
    title,
    content: lines.join("\n"),
    error: null
  };
}

// src/pi-web-access/github-extract.ts
var BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".tiff",
  ".tif",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".flv",
  ".wmv",
  ".wav",
  ".ogg",
  ".webm",
  ".flac",
  ".aac",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".zst",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".lib",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".sqlite",
  ".db",
  ".sqlite3",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".iso",
  ".img",
  ".dmg"
]);
var NOISE_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "vendor",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  ".gradle",
  ".idea",
  ".vscode"
]);
var MAX_INLINE_FILE_CHARS2 = 1e5;
var MAX_TREE_ENTRIES2 = 200;
var CLONE_RUNTIME_OWNER_FILENAME = ".owner.json";
var CLONE_RUNTIME_OWNER_VERSION = 1;
var MAX_CLONE_RUNTIME_OWNER_BYTES = 1024;
var cloneCache = /* @__PURE__ */ new Map();
var startedCloneRuntimeCleanups = /* @__PURE__ */ new Set();
var cachedConfig = null;
var cloneRuntime = null;
function normalizeEnabled(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function normalizePositiveNumber(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value > 0 ? value : fallback;
}
function expandPath(value) {
  let expanded = value;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = expanded.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
  }
  expanded = expanded.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (match, varName) => {
    return process.env[varName] ?? match;
  });
  return expanded;
}
function normalizeClonePath(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) return fallback;
  return expandPath(normalized);
}
function loadGitHubConfig() {
  if (cachedConfig) return cachedConfig;
  const defaults = {
    enabled: true,
    maxRepoSizeMB: 350,
    cloneTimeoutSeconds: 30,
    clonePath: "/tmp/pi-github-repos"
  };
  const raw = loadWebAccessConfig();
  const gc = raw.githubClone ?? {};
  cachedConfig = {
    enabled: normalizeEnabled(gc.enabled, defaults.enabled),
    maxRepoSizeMB: normalizePositiveNumber(gc.maxRepoSizeMB, defaults.maxRepoSizeMB),
    cloneTimeoutSeconds: normalizePositiveNumber(gc.cloneTimeoutSeconds, defaults.cloneTimeoutSeconds),
    clonePath: normalizeClonePath(gc.clonePath, defaults.clonePath)
  };
  return cachedConfig;
}
function parseGitHubUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const segments = [];
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
  if (owner.includes("--")) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;
  if (segments.length === 2) {
    return { owner, repo, refIsFullSha: false, type: "root" };
  }
  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) return null;
  const ref = segments[3];
  if (ref.length === 0 || ref.length > 1024 || /[\0-\x1f\x7f]/.test(ref)) return null;
  const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
  const pathParts = segments.slice(4);
  const path = pathParts.length > 0 ? pathParts.join("/") : "";
  return {
    owner,
    repo,
    ref,
    refIsFullSha,
    path,
    type: action
  };
}
function cacheKey(owner, repo, ref) {
  return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}
function readLinuxBootId() {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    return bootId.length > 0 ? bootId : null;
  } catch {
    return null;
  }
}
async function readLinuxBootIdAsync() {
  try {
    const bootId = (await readFileAsync("/proc/sys/kernel/random/boot_id", "utf-8")).trim();
    return bootId.length > 0 ? bootId : null;
  } catch {
    return null;
  }
}
function parseLinuxProcessInfo(stat) {
  const closingParen = stat.lastIndexOf(") ");
  if (closingParen < 0) return null;
  const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  if (!state || !startTime || !/^\d+$/.test(startTime)) return null;
  return { state, startTime, dead: false };
}
function readLinuxProcessInfo(pid) {
  try {
    return parseLinuxProcessInfo(readFileSync(`/proc/${pid}/stat`, "utf-8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { state: "", startTime: null, dead: true };
    }
    return null;
  }
}
async function readLinuxProcessInfoAsync(pid) {
  try {
    return parseLinuxProcessInfo(await readFileAsync(`/proc/${pid}/stat`, "utf-8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { state: "", startTime: null, dead: true };
    }
    return null;
  }
}
function currentCloneRuntimeOwner() {
  const owner = {
    version: CLONE_RUNTIME_OWNER_VERSION,
    pid: process.pid,
    platform: process.platform
  };
  if (process.platform === "linux") {
    const bootId = readLinuxBootId();
    const processInfo = readLinuxProcessInfo(process.pid);
    if (bootId && processInfo?.startTime) {
      owner.bootId = bootId;
      owner.startTime = processInfo.startTime;
    }
  }
  return owner;
}
function writeCloneRuntimeOwner(runtimePath) {
  const ownerPath = join2(runtimePath, CLONE_RUNTIME_OWNER_FILENAME);
  writeFileSync(ownerPath, JSON.stringify(currentCloneRuntimeOwner()), {
    encoding: "utf-8",
    flag: "wx",
    mode: 384
  });
}
function parseCloneRuntimeOwner(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  if (record.version !== CLONE_RUNTIME_OWNER_VERSION || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.platform !== "string" || record.platform.length === 0 || record.platform.length > 32) {
    return null;
  }
  const owner = {
    version: CLONE_RUNTIME_OWNER_VERSION,
    pid: record.pid,
    platform: record.platform
  };
  if (record.bootId !== void 0) {
    if (typeof record.bootId !== "string" || record.bootId.length === 0 || record.bootId.length > 256) return null;
    owner.bootId = record.bootId;
  }
  if (record.startTime !== void 0) {
    if (typeof record.startTime !== "string" || !/^\d+$/.test(record.startTime)) return null;
    owner.startTime = record.startTime;
  }
  return owner;
}
async function readCloneRuntimeOwner(runtimePath) {
  const ownerPath = join2(runtimePath, CLONE_RUNTIME_OWNER_FILENAME);
  let file;
  try {
    const entry = await lstatAsync(ownerPath);
    if (!entry.isFile() || entry.size > MAX_CLONE_RUNTIME_OWNER_BYTES) return null;
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    file = await openAsync(ownerPath, fsConstants.O_RDONLY | noFollow);
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > MAX_CLONE_RUNTIME_OWNER_BYTES) return null;
    return parseCloneRuntimeOwner(await file.readFile("utf-8"));
  } catch {
    return null;
  } finally {
    if (file !== void 0) {
      try {
        await file.close();
      } catch {
      }
    }
  }
}
function processNonexistenceProven(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "ESRCH");
  }
}
async function cloneRuntimeOwnerIsDead(owner, bootId) {
  if (owner.platform !== process.platform) return false;
  if (process.platform !== "linux") {
    return processNonexistenceProven(owner.pid);
  }
  if (!owner.bootId || !owner.startTime || !bootId) return false;
  const processInfo = await readLinuxProcessInfoAsync(owner.pid);
  if (!processInfo) return false;
  if (processInfo.dead || processInfo.state === "Z" || processInfo.state === "X") return true;
  return processInfo.startTime !== owner.startTime || bootId !== owner.bootId;
}
async function removeCloneRuntimeAsync(parentPath, runtimePath) {
  const normalizedParentPath = resolvePath(parentPath);
  const normalizedRuntimePath = resolvePath(runtimePath);
  if (dirname(normalizedRuntimePath) !== normalizedParentPath || !basename(normalizedRuntimePath).startsWith("runtime-")) return;
  try {
    const realRuntimePath = await realpathAsync(normalizedRuntimePath);
    if (dirname(realRuntimePath) !== normalizedParentPath || basename(realRuntimePath) !== basename(normalizedRuntimePath)) return;
    const entry = await lstatAsync(normalizedRuntimePath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return;
    await rmAsync(normalizedRuntimePath, { recursive: true, force: true });
  } catch {
  }
}
async function sweepStaleCloneRuntimes(parentPath) {
  const normalizedParentPath = resolvePath(parentPath);
  const bootId = process.platform === "linux" ? await readLinuxBootIdAsync() : null;
  try {
    const directory = await opendirAsync(normalizedParentPath);
    for await (const entry of directory) {
      if (!entry.name.startsWith("runtime-")) continue;
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const runtimePath = resolvePath(normalizedParentPath, entry.name);
        if (dirname(runtimePath) !== normalizedParentPath) continue;
        const runtimeEntry = await lstatAsync(runtimePath);
        if (!runtimeEntry.isDirectory() || runtimeEntry.isSymbolicLink()) continue;
        const realRuntimePath = await realpathAsync(runtimePath);
        if (dirname(realRuntimePath) !== normalizedParentPath || basename(realRuntimePath) !== basename(runtimePath)) continue;
        const owner = await readCloneRuntimeOwner(runtimePath);
        if (!owner || !await cloneRuntimeOwnerIsDead(owner, bootId)) continue;
        await removeCloneRuntimeAsync(normalizedParentPath, runtimePath);
      } catch {
      }
    }
  } catch {
  }
}
function startStaleCloneRuntimeCleanup(parentPath) {
  const normalizedParentPath = resolvePath(parentPath);
  if (startedCloneRuntimeCleanups.has(normalizedParentPath)) return;
  startedCloneRuntimeCleanups.add(normalizedParentPath);
  void sweepStaleCloneRuntimes(normalizedParentPath).catch(() => {
  });
}
function removeCloneRuntime(parentPath, runtimePath) {
  const normalizedParentPath = resolvePath(parentPath);
  const normalizedRuntimePath = resolvePath(runtimePath);
  if (dirname(normalizedRuntimePath) !== normalizedParentPath || !basename(normalizedRuntimePath).startsWith("runtime-")) return;
  try {
    const entry = lstatSync(normalizedRuntimePath);
    if (entry.isSymbolicLink()) unlinkSync(normalizedRuntimePath);
    else rmSync(normalizedRuntimePath, { recursive: true, force: true });
  } catch {
  }
}
function getCloneRuntimeRoot(config) {
  if (cloneRuntime) return cloneRuntime.rootPath;
  let parentPath = null;
  let runtimePath = null;
  try {
    const configuredPath = resolvePath(config.clonePath);
    mkdirSync(configuredPath, { recursive: true });
    parentPath = realpathSync(configuredPath);
    startStaleCloneRuntimeCleanup(parentPath);
    runtimePath = mkdtempSync(join2(parentPath, "runtime-"));
    chmodSync(runtimePath, 448);
    const rootPath = realpathSync(runtimePath);
    if (dirname(rootPath) !== parentPath) {
      removeCloneRuntime(parentPath, runtimePath);
      return null;
    }
    writeCloneRuntimeOwner(rootPath);
    cloneRuntime = { parentPath, rootPath };
    return rootPath;
  } catch {
    if (parentPath && runtimePath) removeCloneRuntime(parentPath, runtimePath);
    return null;
  }
}
function cloneDestination(config, owner, repo, ref) {
  try {
    const rootPath = getCloneRuntimeRoot(config);
    if (!rootPath) return null;
    const digest = createHash("sha256").update(JSON.stringify([owner, repo, ref ?? null])).digest("hex");
    const localPath = resolvePath(rootPath, digest);
    if (dirname(localPath) !== rootPath) return null;
    return { rootPath, localPath };
  } catch {
    return null;
  }
}
function removeCloneDestination(destination) {
  const rootPath = resolvePath(destination.rootPath);
  const localPath = resolvePath(destination.localPath);
  if (dirname(localPath) !== rootPath || !/^[0-9a-f]{64}$/.test(basename(localPath))) return false;
  try {
    const entry = lstatSync(localPath);
    if (entry.isSymbolicLink()) unlinkSync(localPath);
    else rmSync(localPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true;
    return false;
  }
}
var PROCESS_KILL_GRACE_MS = 3e3;
function terminateProcessTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = execFile2(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      (err) => {
        if (err) child.kill();
      }
    );
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill();
  }
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, PROCESS_KILL_GRACE_MS);
  forceKill.unref();
}
function execClone(args, destination, timeoutMs, signal) {
  return new Promise((resolve) => {
    const { localPath } = destination;
    let settled = false;
    let timeout;
    let onAbort;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (!success) {
        removeCloneDestination(destination);
        resolve(null);
        return;
      }
      resolve(localPath);
    };
    const child = spawn2(args[0], args.slice(1), {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GH_PROMPT_DISABLED: "1"
      },
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    timeout = setTimeout(() => terminateProcessTree(child), timeoutMs);
    timeout.unref();
    if (signal) {
      onAbort = () => {
        if (timeout) clearTimeout(timeout);
        terminateProcessTree(child);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
async function cloneRepo(owner, repo, ref, config, destination, signal) {
  const { localPath } = destination;
  if (!removeCloneDestination(destination)) return null;
  const timeoutMs = config.cloneTimeoutSeconds * 1e3;
  const hasGh = await checkGhAvailable();
  if (hasGh) {
    const args2 = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
    if (ref) args2.push("--branch", ref);
    return execClone(args2, destination, timeoutMs, signal);
  }
  showGhHint();
  const gitUrl = `https://github.com/${owner}/${repo}.git`;
  const args = ["git", "clone", "--depth", "1", "--single-branch"];
  if (ref) args.push("--branch", ref);
  args.push(gitUrl, localPath);
  return execClone(args, destination, timeoutMs, signal);
}
function isBinaryFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
  return false;
}
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function resolveWithinRepo(rootPath, relativePath) {
  const normalizedRoot = resolvePath(rootPath);
  const candidate = resolvePath(normalizedRoot, relativePath);
  if (candidate !== normalizedRoot) {
    const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
    if (!candidate.startsWith(rootPrefix)) return null;
  }
  if (!existsSync(candidate)) return candidate;
  try {
    const realRoot = realpathSync(normalizedRoot);
    const realCandidate = realpathSync(candidate);
    if (realCandidate === realRoot) return candidate;
    const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
    return realCandidate.startsWith(realRootPrefix) ? candidate : null;
  } catch {
    return null;
  }
}
function readTextFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
function buildTree(rootPath) {
  const entries = [];
  function walk(dir, relPath) {
    if (entries.length >= MAX_TREE_ENTRIES2) return;
    let items;
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES2) return;
      if (item === ".git") continue;
      const rel = relPath ? `${relPath}/${item}` : item;
      const safePath = resolveWithinRepo(rootPath, rel);
      if (!safePath) {
        entries.push(`${rel}  [outside repo skipped]`);
        continue;
      }
      let stat;
      try {
        stat = statSync(safePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${rel}/  [skipped]`);
          continue;
        }
        entries.push(`${rel}/`);
        walk(safePath, rel);
      } else {
        entries.push(rel);
      }
    }
  }
  walk(rootPath, "");
  if (entries.length >= MAX_TREE_ENTRIES2) {
    entries.push(`... (truncated at ${MAX_TREE_ENTRIES2} entries)`);
  }
  return entries.join("\n");
}
function buildDirListing(rootPath, subPath) {
  const targetPath = resolveWithinRepo(rootPath, subPath);
  if (!targetPath) return "(path escapes repository root)";
  const lines = [];
  let items;
  try {
    items = readdirSync(targetPath).sort();
  } catch {
    return "(directory not readable)";
  }
  for (const item of items) {
    if (item === ".git") continue;
    const rel = subPath ? `${subPath}/${item}` : item;
    const safePath = resolveWithinRepo(rootPath, rel);
    if (!safePath) {
      lines.push(`  ${item}  (outside repo)`);
      continue;
    }
    try {
      const stat = statSync(safePath);
      if (stat.isDirectory()) {
        lines.push(`  ${item}/`);
      } else {
        lines.push(`  ${item}  (${formatFileSize(stat.size)})`);
      }
    } catch {
      lines.push(`  ${item}  (unreadable)`);
    }
  }
  return lines.join("\n");
}
function readReadme(localPath) {
  const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
  for (const name of candidates) {
    const readmePath = resolveWithinRepo(localPath, name);
    if (!readmePath) continue;
    const content = readTextFile(readmePath);
    if (content !== null) {
      return content.length > 8192 ? content.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : content;
    }
  }
  return null;
}
function generateContent(localPath, info) {
  const lines = [];
  lines.push(`Repository cloned to: ${localPath}`);
  lines.push("");
  if (info.type === "root") {
    lines.push("## Structure");
    lines.push(buildTree(localPath));
    lines.push("");
    const readme = readReadme(localPath);
    if (readme) {
      lines.push("## README.md");
      lines.push(readme);
      lines.push("");
    }
    lines.push("Use `read` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }
  if (info.type === "tree") {
    const dirPath = info.path || "";
    const fullDirPath = resolveWithinRepo(localPath, dirPath);
    if (!fullDirPath || !existsSync(fullDirPath)) {
      lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`);
      lines.push("");
      lines.push("## Structure");
      lines.push(buildTree(localPath));
    } else {
      lines.push(`## ${dirPath || "/"}`);
      lines.push(buildDirListing(localPath, dirPath));
    }
    lines.push("");
    lines.push("Use `read` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }
  if (info.type === "blob") {
    const filePath = info.path || "";
    const fullFilePath = resolveWithinRepo(localPath, filePath);
    if (!fullFilePath || !existsSync(fullFilePath)) {
      lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`);
      lines.push("");
      lines.push("## Structure");
      lines.push(buildTree(localPath));
      lines.push("");
      lines.push("Use `read` and `bash` tools at the path above to explore further.");
      return lines.join("\n");
    }
    let stat;
    try {
      stat = statSync(fullFilePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`Could not inspect \`${filePath}\`: ${message}`);
      lines.push("");
      lines.push("Use `read` and `bash` tools at the path above to explore further.");
      return lines.join("\n");
    }
    if (stat.isDirectory()) {
      lines.push(`## ${filePath || "/"}`);
      lines.push(buildDirListing(localPath, filePath));
      lines.push("");
      lines.push("Use `read` and `bash` tools at the path above to explore further.");
      return lines.join("\n");
    }
    if (isBinaryFile(fullFilePath)) {
      const ext = extname(filePath).replace(".", "");
      lines.push(`## ${filePath}`);
      lines.push(`Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`);
      return lines.join("\n");
    }
    const content = readTextFile(fullFilePath);
    if (content === null) {
      lines.push(`Could not read \`${filePath}\` as UTF-8 text.`);
      lines.push("");
      lines.push("Use `read` and `bash` tools at the path above to explore further.");
      return lines.join("\n");
    }
    lines.push(`## ${filePath}`);
    if (content.length > MAX_INLINE_FILE_CHARS2) {
      lines.push(content.slice(0, MAX_INLINE_FILE_CHARS2));
      lines.push("");
      lines.push(`[File truncated at 100K chars. Full file: ${fullFilePath}]`);
    } else {
      lines.push(content);
    }
    lines.push("");
    lines.push("Use `read` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }
  return lines.join("\n");
}
async function awaitCachedClone(cached, url, owner, repo, info, signal) {
  if (signal?.aborted) return null;
  const result = await cached.clonePromise;
  if (signal?.aborted) return null;
  if (result) {
    const content = generateContent(result, info);
    const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
    return { url, title, content, error: null };
  }
  return fetchViaApi(url, owner, repo, info);
}
async function extractGitHub(url, signal, forceClone) {
  const info = parseGitHubUrl(url);
  if (!info) return null;
  if (signal?.aborted) return null;
  const config = loadGitHubConfig();
  if (!config.enabled) return null;
  const { owner, repo } = info;
  const key = cacheKey(owner, repo, info.ref);
  const cached = cloneCache.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return awaitCachedClone(cached, url, owner, repo, info, signal);
  }
  if (info.refIsFullSha) {
    if (signal?.aborted) return null;
    const sizeNote = `Note: Commit SHA URLs use the GitHub API instead of cloning.`;
    return fetchViaApi(url, owner, repo, info, sizeNote);
  }
  const activityId = activityMonitor.logStart({ type: "fetch", url: `github.com/${owner}/${repo}` });
  if (!forceClone) {
    const sizeKB = await checkRepoSize(owner, repo);
    if (signal?.aborted) {
      activityMonitor.logComplete(activityId, 0);
      return null;
    }
    if (sizeKB !== null) {
      const sizeMB = sizeKB / 1024;
      if (sizeMB > config.maxRepoSizeMB) {
        if (signal?.aborted) {
          activityMonitor.logComplete(activityId, 0);
          return null;
        }
        const sizeNote = `Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${config.maxRepoSizeMB}MB). Showing API-fetched content instead of full clone. Ask the user if they'd like to clone the full repo -- if yes, call fetch_content again with the same URL and add forceClone: true to the params.`;
        const apiView = await fetchViaApi(url, owner, repo, info, sizeNote);
        if (apiView) {
          activityMonitor.logComplete(activityId, 200);
          return apiView;
        }
        activityMonitor.logError(activityId, "api fallback unavailable for oversized repository");
        return null;
      }
    }
  }
  if (signal?.aborted) {
    activityMonitor.logComplete(activityId, 0);
    return null;
  }
  const cachedAfterSizeCheck = cloneCache.get(key);
  if (cachedAfterSizeCheck) {
    cachedAfterSizeCheck.lastUsedAt = Date.now();
    const cachedResult = await awaitCachedClone(cachedAfterSizeCheck, url, owner, repo, info, signal);
    if (signal?.aborted) {
      activityMonitor.logComplete(activityId, 0);
    } else if (cachedResult) {
      activityMonitor.logComplete(activityId, 200);
    } else {
      activityMonitor.logError(activityId, "clone failed");
    }
    return cachedResult;
  }
  const destination = cloneDestination(config, owner, repo, info.ref);
  if (!destination) {
    const apiFallback = await fetchViaApi(url, owner, repo, info);
    if (apiFallback) activityMonitor.logComplete(activityId, 200);
    else activityMonitor.logError(activityId, "invalid clone destination");
    return apiFallback;
  }
  const clonePromise = cloneRepo(owner, repo, info.ref, config, destination, signal);
  const entry = { destination, clonePromise, lastUsedAt: Date.now(), settled: false };
  cloneCache.set(key, entry);
  void clonePromise.finally(() => {
    entry.settled = true;
  });
  const result = await clonePromise;
  if (signal?.aborted) {
    if (!result) cloneCache.delete(key);
    activityMonitor.logComplete(activityId, 0);
    return null;
  }
  if (!result) {
    cloneCache.delete(key);
    if (signal?.aborted) {
      activityMonitor.logComplete(activityId, 0);
      return null;
    }
    const apiFallback = await fetchViaApi(url, owner, repo, info);
    if (apiFallback) {
      activityMonitor.logComplete(activityId, 200);
      return apiFallback;
    }
    activityMonitor.logError(activityId, "clone and API fallback failed");
    return null;
  }
  activityMonitor.logComplete(activityId, 200);
  const content = generateContent(result, info);
  const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
  return { url, title, content, error: null };
}
function touchClones(urls) {
  const now = Date.now();
  for (const url of urls) {
    const info = parseGitHubUrl(url);
    if (!info) continue;
    const entry = cloneCache.get(cacheKey(info.owner, info.repo, info.ref));
    if (entry) entry.lastUsedAt = now;
  }
}
function releaseClonesUnusedSince(time) {
  for (const [key, entry] of cloneCache) {
    if (!entry.settled || entry.lastUsedAt >= time) continue;
    removeCloneDestination(entry.destination);
    cloneCache.delete(key);
  }
}
function clearCloneCache() {
  for (const entry of cloneCache.values()) {
    removeCloneDestination(entry.destination);
  }
  cloneCache.clear();
  if (cloneRuntime) {
    removeCloneRuntime(cloneRuntime.parentPath, cloneRuntime.rootPath);
  }
  cloneRuntime = null;
  cachedConfig = null;
}

// src/pi-web-access/credential-source.ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
var execAsync = promisify(exec);
var COMMAND_TIMEOUT_MS = 5e3;
var MAX_CREDENTIAL_BYTES = 16384;
var ENV_SOURCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
var OP_SESSION_NAME = /^OP_SESSION_[A-Za-z0-9_]+$/;
var COMMAND_ENVIRONMENT_NAMES = [
  "HOME",
  "USER",
  "LOGNAME",
  "OP_SERVICE_ACCOUNT_TOKEN",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP"
];
var CredentialResolutionError = class extends Error {
  provider;
  category;
  constructor(provider, category) {
    const suffix = category === "command-aborted" ? "aborted" : category === "oauth-credential-rejected" ? "OAuth token exchange rejected the credentials" : category;
    super(`${provider} credential resolution failed: ${suffix}`);
    this.name = "CredentialResolutionError";
    this.provider = provider;
    this.category = category;
  }
};
function redactCredential(text, credential) {
  return credential ? text.split(credential).join("[redacted]") : text;
}
function normalize(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
function commandEnvironment(source) {
  const environment = {};
  for (const name of COMMAND_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== void 0) environment[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== void 0 && OP_SESSION_NAME.test(name)) environment[name] = value;
  }
  return environment;
}
function configuredSource(options) {
  return normalize(options.configuredValue);
}
function explicitEnvironmentName(source) {
  const match = source.match(ENV_SOURCE);
  return match ? match[1] ?? match[2] : null;
}
function escapedSource(source) {
  if (source.startsWith("$$") || source.startsWith("$!")) return source.slice(1);
  return null;
}
function isMalformedExplicitSource(source) {
  return source.startsWith("$") && escapedSource(source) === null && explicitEnvironmentName(source) === null;
}
async function defaultRunCommand(command, options) {
  const result = await execAsync(command, {
    encoding: "utf8",
    env: options.environment,
    maxBuffer: options.maxOutputBytes + 1,
    signal: options.signal,
    timeout: options.timeoutMs,
    windowsHide: true
  });
  return { stdout: result.stdout };
}
function commandFailureCategory(error, signal) {
  if (signal?.aborted) return "command-aborted";
  if (error && typeof error === "object") {
    const code = error.code;
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "command-output-too-large";
    if (error.killed || code === "ETIMEDOUT") return "command-timeout";
  }
  return "command-failed";
}
function toRequestHeaders(headers) {
  const requestHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null) requestHeaders[name] = value;
  }
  return requestHeaders;
}
function requireProviderCredential(apiKey, setup) {
  if (!apiKey) throw new Error(
    `${setup.provider} API key not found. Either:
  1. Create ${setup.configPath} with { "${setup.configKey}": "your-key" }
  2. Set ${setup.envVar} environment variable
` + setup.keyInstructions
  );
  return apiKey;
}
function hasCredentialSource(options) {
  const source = configuredSource(options);
  if (source?.startsWith("!")) return true;
  if (source?.startsWith("$")) return true;
  return normalize(options.environmentValue) !== null || source !== null;
}
async function resolveCredential(options) {
  const source = configuredSource(options);
  const escaped = source ? escapedSource(source) : null;
  if (escaped !== null) return escaped;
  if (source?.startsWith("!")) {
    const command = source.slice(1).trim();
    if (!command) throw new CredentialResolutionError(options.provider, "invalid-source");
    let result;
    try {
      result = await (options.runCommand ?? defaultRunCommand)(command, {
        signal: options.signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_CREDENTIAL_BYTES,
        environment: commandEnvironment(options.environment ?? process.env)
      });
    } catch (error) {
      throw new CredentialResolutionError(options.provider, commandFailureCategory(error, options.signal));
    }
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    if (Buffer.byteLength(stdout, "utf8") > MAX_CREDENTIAL_BYTES) {
      throw new CredentialResolutionError(options.provider, "command-output-too-large");
    }
    const value = stdout.trim();
    if (!value) throw new CredentialResolutionError(options.provider, "command-empty");
    if (/[\0-\x1f\x7f]/.test(value)) {
      throw new CredentialResolutionError(options.provider, "command-invalid-output");
    }
    return value;
  }
  if (source && isMalformedExplicitSource(source)) {
    throw new CredentialResolutionError(options.provider, "invalid-source");
  }
  if (source?.startsWith("$")) {
    const name = explicitEnvironmentName(source);
    if (!name) throw new CredentialResolutionError(options.provider, "invalid-source");
    const value = normalize((options.environment ?? process.env)[name]);
    if (!value) throw new CredentialResolutionError(options.provider, "environment-empty");
    return value;
  }
  return normalize(options.environmentValue) ?? source;
}

// src/pi-web-access/search-types.ts
var SearchUnsupportedFilterError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchUnsupportedFilterError";
  }
};
var SearchHttpError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "SearchHttpError";
    this.status = status;
  }
};

// src/pi-web-access/search-error-redaction.ts
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function redactSearchFailure(error, credential) {
  const message = errorMessage(error);
  const redacted = redactCredential(message, credential);
  if (redacted === message) return { message, error };
  const safeError = error instanceof SearchHttpError ? new SearchHttpError(error.status, redacted) : new Error(redacted);
  if (error instanceof Error) safeError.name = error.name;
  return { message: redacted, error: safeError };
}

// src/pi-web-access/chrome-cookies.ts
import { execFile as execFile3 } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync as existsSync2, mkdtempSync as mkdtempSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, realpathSync as realpathSync2, rmSync as rmSync2 } from "node:fs";
import { tmpdir as tmpdir2, homedir } from "node:os";
import { isAbsolute, join as join3, sep } from "node:path";

// src/pi-web-access/gemini-web-config.ts
var BROWSER_COOKIE_PRESETS = ["helium", "chrome", "brave", "arc", "chromium", "edge"];
var cachedConfig2 = null;
function normalizeChromeProfile(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : void 0;
}
function parseBrowserCookies(value) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`browserCookies in ${webPreferencesPath()} must be an object`);
  }
  const raw = value;
  if ("profilePath" in raw) {
    throw new Error(`browserCookies.profilePath is not supported; use a browser preset and profile directory name in ${webPreferencesPath()}`);
  }
  let browser;
  if (raw.browser !== void 0) {
    if (typeof raw.browser !== "string") throw new Error(`browserCookies.browser in ${webPreferencesPath()} must be a supported browser name`);
    const normalized = raw.browser.trim().toLowerCase();
    const preset = BROWSER_COOKIE_PRESETS.find((candidate) => candidate === normalized);
    if (!preset) {
      throw new Error(`Unsupported browserCookies.browser ${JSON.stringify(raw.browser)} in ${webPreferencesPath()}`);
    }
    browser = preset;
  }
  if (raw.profile !== void 0 && typeof raw.profile !== "string") {
    throw new Error(`browserCookies.profile in ${webPreferencesPath()} must be a profile directory name`);
  }
  const profile = normalizeChromeProfile(raw.profile);
  if (profile && (profile === "." || profile === ".." || profile.includes("/") || profile.includes("\\"))) {
    throw new Error(`browserCookies.profile in ${webPreferencesPath()} must be a profile directory name, not a path`);
  }
  return { ...browser ? { browser } : {}, ...profile ? { profile } : {} };
}
function loadConfig() {
  if (cachedConfig2) return cachedConfig2;
  const raw = loadWebAccessConfig();
  if (raw.chromeProfile !== void 0) {
    throw new Error(`chromeProfile in ${webPreferencesPath()} is no longer supported; use browserCookies.profile`);
  }
  cachedConfig2 = {
    browserCookies: parseBrowserCookies(raw.browserCookies)
  };
  return cachedConfig2;
}
function getBrowserCookieSelectionFromConfig() {
  return { ...loadConfig().browserCookies };
}
function isBrowserCookieAccessAllowed() {
  if (process.env.PI_ALLOW_BROWSER_COOKIES === "1") return true;
  const raw = loadWebAccessConfig();
  return raw.allowBrowserCookies === true;
}

// src/pi-web-access/chrome-cookies.ts
var GOOGLE_ORIGINS = [
  "https://gemini.google.com",
  "https://accounts.google.com",
  "https://www.google.com"
];
var ALL_COOKIE_NAMES = /* @__PURE__ */ new Set([
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "NID",
  "AEC",
  "SOCS",
  "__Secure-BUCKET",
  "__Secure-ENID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PAPISID",
  "SIDCC"
]);
var MACOS_BROWSER_CONFIGS = [
  { id: "helium", name: "Helium", baseDir: "Library/Application Support/net.imput.helium", keychainService: "Helium Storage Key", keychainAccount: "Helium" },
  { id: "chrome", name: "Chrome", baseDir: "Library/Application Support/Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { id: "brave", name: "Brave", baseDir: "Library/Application Support/BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
  { id: "arc", name: "Arc", baseDir: "Library/Application Support/Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" }
];
var LINUX_BROWSER_CONFIGS = [
  { id: "chromium", name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium", kwalletFolder: "Chromium Keys", kwalletEntry: "Chromium Safe Storage" },
  { id: "chrome", name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome", kwalletFolder: "Chrome Keys", kwalletEntry: "Chrome Safe Storage" }
];
var WINDOWS_BROWSER_CONFIGS = [
  { id: "chrome", name: "Chrome", baseDir: "Google/Chrome/User Data", usesLocalAppData: true },
  { id: "edge", name: "Edge", baseDir: "Microsoft/Edge/User Data", usesLocalAppData: true }
];
var browserPasswordCache = /* @__PURE__ */ new Map();
var sqliteModule = null;
var sqliteImportAttempted = false;
async function getGoogleCookies(options) {
  return getBrowserCookiesForHosts({
    hosts: GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname),
    browser: options?.browser,
    profile: options?.profile,
    requiredCookies: options?.requiredCookies,
    cookieNames: ALL_COOKIE_NAMES,
    requiredLabel: "Gemini"
  });
}
async function getBrowserCookiesForHosts(options) {
  const attempts = [];
  const failure = (message) => ({ ok: false, diagnostic: { message, attempts } });
  if (!isBrowserCookieAccessAllowed()) {
    return failure("Browser cookie access is disabled; enable allowBrowserCookies to use browser cookies.");
  }
  const currentPlatform = process.platform;
  const platformConfigs = currentPlatform === "darwin" ? MACOS_BROWSER_CONFIGS : currentPlatform === "linux" ? LINUX_BROWSER_CONFIGS : currentPlatform === "win32" ? WINDOWS_BROWSER_CONFIGS : [];
  const configs = options.browser ? platformConfigs.filter((config) => config.id === options.browser) : platformConfigs;
  if (options.browser && configs.length === 0) {
    return failure(`Browser preset '${options.browser}' is not supported on this platform.`);
  }
  if (configs.length === 0) {
    return failure("Chromium cookie extraction is unsupported on this platform.");
  }
  const warningSet = /* @__PURE__ */ new Set();
  const rawProfile = typeof options.profile === "string" ? options.profile.trim() : "";
  const requestedProfile = normalizeProfileName(options.profile);
  if (rawProfile && !requestedProfile) {
    return failure("Configured Chromium profile must be a profile directory name, not a path.");
  }
  const requiredCookies = normalizeCookieNames(options.requiredCookies);
  const cookieNames = normalizeCookieNames(options.cookieNames ? [...options.cookieNames] : void 0);
  const hosts = normalizeHosts(options.hosts);
  if (hosts.length === 0) {
    return failure("No valid cookie hosts were requested.");
  }
  const home = currentPlatform === "win32" ? process.env.USERPROFILE || homedir() : homedir();
  let sawCookieDatabase = false;
  let sawRequiredCookies = false;
  let sawAnyHostCookie = false;
  let sawBackendFailure;
  let sawUnsafeProfilePath = false;
  let sawWindowsAppBoundCookie = false;
  let sawDecryptionFailure = false;
  for (const config of configs) {
    const profiles = requestedProfile ? [requestedProfile] : listBrowserProfiles(home, config);
    for (const profile of profiles) {
      const profilePath = resolveProfilePath(home, config, profile);
      if (profilePath === "outside-root") {
        sawUnsafeProfilePath = true;
        recordCookieAttempt(attempts, config, profile, "unsafe-profile");
        continue;
      }
      if (!profilePath) {
        recordCookieAttempt(attempts, config, profile, "missing-database");
        continue;
      }
      const cookiesPath = cookieDatabasePath(profilePath, config);
      if (!cookiesPath) {
        recordCookieAttempt(attempts, config, profile, "missing-database");
        continue;
      }
      sawCookieDatabase = true;
      const tempDir = mkdtempSync2(join3(tmpdir2(), "pi-chrome-cookies-"));
      try {
        const tempDb = join3(tempDir, "Cookies");
        copyFileSync(cookiesPath, tempDb);
        copySidecar(cookiesPath, tempDb, "-wal");
        copySidecar(cookiesPath, tempDb, "-shm");
        if (requiredCookies?.length) {
          const preflight = await hasCookieNames(tempDb, hosts, requiredCookies);
          if (preflight.failure) {
            sawBackendFailure = preflight.failure;
            recordCookieAttempt(attempts, config, profile, preflight.failure === "unavailable" ? "sqlite-unavailable" : "sqlite-query-failed");
            continue;
          }
          if (!preflight.present) {
            recordCookieAttempt(attempts, config, profile, "missing-required-cookies");
            continue;
          }
          sawRequiredCookies = true;
        }
        const browserPasswords = currentPlatform === "win32" ? [] : await readBrowserPasswords(config, currentPlatform);
        for (const password of browserPasswords) if (password.warning) warningSet.add(password.warning);
        const windowsKey = currentPlatform === "win32" ? await readWindowsEncryptionKey(config, home) : null;
        const browserKeys = browserPasswords.flatMap((password) => password.value ? [pbkdf2Sync(password.value, "saltysalt", currentPlatform === "darwin" ? 1003 : 1, 16, "sha1")] : []);
        if (currentPlatform === "win32" ? !windowsKey : browserKeys.length === 0) {
          warningSet.add(currentPlatform === "win32" ? `Could not read ${config.name} Windows cookie encryption key` : `Could not read ${config.name} cookie encryption password`);
          recordCookieAttempt(attempts, config, profile, "password-read-failed");
          continue;
        }
        const metaVersion = await readMetaVersion(tempDb);
        if (metaVersion.failure) {
          sawBackendFailure = metaVersion.failure;
          recordCookieAttempt(attempts, config, profile, metaVersion.failure === "unavailable" ? "sqlite-unavailable" : "sqlite-query-failed");
        }
        if (metaVersion.value === null) continue;
        const rowsResult = await queryCookieRows(tempDb, hosts, cookieNames ?? null, Boolean(options.requestUrl));
        if (rowsResult.status === "failure") {
          sawBackendFailure = rowsResult.failure;
          recordCookieAttempt(attempts, config, profile, rowsResult.failure === "unavailable" ? "sqlite-unavailable" : "sqlite-query-failed");
          continue;
        }
        const entries = [];
        const cookies = {};
        const requiredDecryptFailures = /* @__PURE__ */ new Set();
        let kwalletAttempted = browserPasswords.some((password) => password.source === "kwallet");
        for (const row of rowsResult.rows) {
          const name = typeof row.name === "string" ? row.name : "";
          if (!name) continue;
          let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
          if (!value && typeof row.encrypted_value_hex === "string" && /^[0-9a-f]*$/i.test(row.encrypted_value_hex)) {
            const encrypted = Buffer.from(row.encrypted_value_hex, "hex");
            if (currentPlatform === "win32" && encrypted.subarray(0, 3).toString("utf8") === "v20") sawWindowsAppBoundCookie = true;
            if (currentPlatform === "win32") {
              value = decryptWindowsCookieValue(encrypted, windowsKey, metaVersion.value >= 24);
            } else {
              for (const key of browserKeys) {
                value = decryptCookieValue(encrypted, key, metaVersion.value >= 24);
                if (value) break;
              }
            }
            if (!value && currentPlatform === "linux" && !kwalletAttempted && browserPasswords.some((password) => password.source === "secret-service") && requiredCookies?.includes(name)) {
              kwalletAttempted = true;
              const fallback = await readKWalletPassword(config);
              if (fallback.warning) warningSet.add(fallback.warning);
              if (fallback.value) {
                const key = pbkdf2Sync(fallback.value, "saltysalt", 1, 16, "sha1");
                browserKeys.push(key);
                value = decryptCookieValue(encrypted, key, metaVersion.value >= 24);
                if (value) {
                  browserPasswords.push(fallback);
                  browserPasswordCache.set(passwordCacheKey(config, currentPlatform), Promise.resolve([...browserPasswords]));
                }
              }
            }
            if (!value && requiredCookies?.includes(name)) requiredDecryptFailures.add(name);
          }
          if (!value) continue;
          const path = typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/";
          if (options.requestUrl && !pathMatches(options.requestUrl.pathname || "/", path)) continue;
          entries.push({ name, value, path });
          if (!cookies[name]) cookies[name] = value;
        }
        if (entries.length > 0) sawAnyHostCookie = true;
        if (requiredCookies?.length && !requiredCookies.every((name) => Boolean(cookies[name]))) {
          if (requiredCookies.some((name) => !cookies[name] && requiredDecryptFailures.has(name))) {
            sawDecryptionFailure = true;
            recordCookieAttempt(attempts, config, profile, "decryption-failed");
          } else {
            recordCookieAttempt(attempts, config, profile, "missing-required-cookies");
          }
          continue;
        }
        if (entries.length === 0) {
          recordCookieAttempt(attempts, config, profile, requiredDecryptFailures.size > 0 ? "decryption-failed" : "no-host-cookies");
          if (requiredDecryptFailures.size > 0) sawDecryptionFailure = true;
          continue;
        }
        return {
          ok: true,
          cookies,
          warnings: [...warningSet],
          ...options.requestUrl ? { cookieHeader: buildCookieHeader(entries) } : {}
        };
      } finally {
        rmSync2(tempDir, { recursive: true, force: true });
      }
    }
  }
  if (sawBackendFailure === "unavailable") {
    return failure("SQLite backend unavailable: install sqlite3 or use a runtime with SQLite support.");
  } else if (sawBackendFailure === "query") {
    return failure("SQLite query failed while reading the copied Chromium cookie database.");
  } else if (sawUnsafeProfilePath) {
    return failure("Configured Chromium profile must resolve inside the browser profile root.");
  } else if (!sawCookieDatabase) {
    return failure(requestedProfile ? `Chromium profile '${requestedProfile}' does not contain a cookie database.` : "No detected Chromium profile contains a cookie database.");
  } else if (requiredCookies?.length && !sawRequiredCookies) {
    return failure(`No detected Chromium profile contains the required ${options.requiredLabel ?? "browser"} cookies.`);
  } else if (sawWindowsAppBoundCookie) {
    return failure("Windows Chromium v20 app-bound cookies are not supported.");
  } else if (warningSet.size > 0) {
    return failure([...warningSet][0]);
  } else if (sawDecryptionFailure) {
    return failure(`Required ${options.requiredLabel ?? "browser"} cookies could not be decrypted.`);
  } else if (!sawAnyHostCookie) {
    return failure(options.requestUrl ? "No detected Chromium profile contains cookies for the requested URL." : "No detected Chromium profile contains cookies for the requested host.");
  } else {
    return failure("Required Gemini cookies were not available or could not be decrypted.");
  }
}
function recordCookieAttempt(attempts, config, profile, status) {
  attempts.push({ browser: config.name, profile, status });
}
function normalizeProfileName(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim();
  if (!normalized) return void 0;
  if (isAbsolute(normalized) || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
    return void 0;
  }
  return normalized;
}
function resolveProfilePath(home, config, profile) {
  const basePath = browserBasePath(home, config);
  const profilePath = join3(basePath, profile);
  if (!cookieDatabasePath(profilePath, config)) return null;
  try {
    const baseRealPath = realpathSync2(basePath);
    const profileRealPath = realpathSync2(profilePath);
    if (profileRealPath !== baseRealPath && !profileRealPath.startsWith(`${baseRealPath}${sep}`)) return "outside-root";
    return profileRealPath;
  } catch {
    return null;
  }
}
function cookieDatabasePath(profilePath, config) {
  const networkCookies = join3(profilePath, "Network", "Cookies");
  if (config.usesLocalAppData && existsSync2(networkCookies)) return networkCookies;
  const legacyCookies = join3(profilePath, "Cookies");
  return existsSync2(legacyCookies) ? legacyCookies : null;
}
function browserBasePath(home, config) {
  return config.usesLocalAppData ? join3(process.env.LOCALAPPDATA || join3(home, "AppData", "Local"), config.baseDir) : join3(home, config.baseDir);
}
function normalizeCookieNames(names) {
  if (!names?.length) return void 0;
  const normalized = names.filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : void 0;
}
function normalizeHosts(hosts) {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")).filter(Boolean))];
}
function listBrowserProfiles(home, config) {
  const basePath = browserBasePath(home, config);
  if (!existsSync2(basePath)) return ["Default"];
  const profiles = /* @__PURE__ */ new Set();
  try {
    for (const entry of readdirSync2(basePath, { withFileTypes: true })) {
      if (entry.isDirectory() && cookieDatabasePath(join3(basePath, entry.name), config)) profiles.add(entry.name);
    }
  } catch {
  }
  if (profiles.size === 0) return ["Default"];
  return [...profiles].sort(compareProfileNames);
}
function compareProfileNames(a, b) {
  const key = (name) => {
    if (name === "Default") return [0, 0];
    const profile = /^Profile\s+(\d+)$/i.exec(name);
    if (profile) return [1, Number(profile[1])];
    const person = /^Person\s+(\d+)$/i.exec(name);
    if (person) return [2, Number(person[1])];
    return [3, Number.MAX_SAFE_INTEGER];
  };
  const [ap, ai] = key(a);
  const [bp, bi] = key(b);
  return ap - bp || ai - bi || a.localeCompare(b, void 0, { sensitivity: "base", numeric: true });
}
function decryptCookieValue(encrypted, key, stripHash) {
  const buf = Buffer.from(encrypted);
  if (buf.length < 3 || !/^v\d\d$/.test(buf.subarray(0, 3).toString("utf8"))) return null;
  const ciphertext = buf.subarray(3);
  if (!ciphertext.length) return "";
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    decipher.setAutoPadding(false);
    const unpadded = removePkcs7Padding(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let i = 0;
    while (i < decoded.length && decoded.charCodeAt(i) < 32) i++;
    return decoded.slice(i);
  } catch {
    return null;
  }
}
function decryptWindowsCookieValue(encrypted, key, stripHash) {
  const buf = Buffer.from(encrypted);
  if (buf.subarray(0, 3).toString("utf8") !== "v10" || buf.length < 3 + 12 + 16) return null;
  try {
    const nonce = buf.subarray(3, 15);
    const ciphertext = buf.subarray(15, -16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(buf.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(stripHash && plaintext.length >= 32 ? plaintext.subarray(32) : plaintext);
  } catch {
    return null;
  }
}
function removePkcs7Padding(buf) {
  if (!buf.length) return buf;
  const padding = buf[buf.length - 1];
  return !padding || padding > 16 ? buf : buf.subarray(0, buf.length - padding);
}
function passwordCacheKey(config, currentPlatform) {
  return `${currentPlatform}:${config.name}`;
}
function readBrowserPasswords(config, currentPlatform) {
  const cacheKey2 = passwordCacheKey(config, currentPlatform);
  const cached = browserPasswordCache.get(cacheKey2);
  if (cached) return cached;
  const passwordResult = currentPlatform === "darwin" ? config.keychainAccount && config.keychainService ? readKeychainPassword(config.keychainAccount, config.keychainService).then((value) => ({ value, cacheable: Boolean(value) })) : Promise.resolve({ value: null, cacheable: false }) : currentPlatform === "linux" ? readLinuxPassword(config) : Promise.resolve({ value: null, cacheable: false });
  const passwordPromise = passwordResult.then(({ cacheable, ...password }) => {
    if (!cacheable) browserPasswordCache.delete(cacheKey2);
    return [password];
  }, (error) => {
    browserPasswordCache.delete(cacheKey2);
    throw error;
  });
  browserPasswordCache.set(cacheKey2, passwordPromise);
  return passwordPromise;
}
async function readWindowsEncryptionKey(config, home) {
  try {
    const localState = JSON.parse(readFileSync2(join3(browserBasePath(home, config), "Local State"), "utf8"));
    const encodedKey = localState.os_crypt?.encrypted_key;
    if (typeof encodedKey !== "string") return null;
    const protectedKey = Buffer.from(encodedKey, "base64");
    if (protectedKey.subarray(0, 5).toString("utf8") !== "DPAPI") return null;
    const decrypted = await unprotectWindowsData(protectedKey.subarray(5));
    return decrypted?.length === 32 ? decrypted : null;
  } catch {
    return null;
  }
}
function unprotectWindowsData(protectedData) {
  return new Promise((resolve) => {
    const script = "Add-Type -AssemblyName System.Security;$data=[Convert]::FromBase64String($env:PIWA_PROTECTED);$clear=[System.Security.Cryptography.ProtectedData]::Unprotect($data,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($clear))";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile3("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 5e3, maxBuffer: 1024 * 1024, env: { ...process.env, PIWA_PROTECTED: protectedData.toString("base64") } }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(Buffer.from(stdout.trim(), "base64"));
      } catch {
        resolve(null);
      }
    });
  });
}
function readKeychainPassword(account, service) {
  return new Promise((resolve) => {
    execFile3("security", ["find-generic-password", "-w", "-a", account, "-s", service], { timeout: 5e3 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
}
function readLinuxCommandPassword(command, args) {
  return new Promise((resolve) => {
    execFile3(command, args, { timeout: 5e3 }, (err, stdout) => resolve({ value: err ? null : stdout.trim() || null, failed: Boolean(err) }));
  });
}
function isKdeSession() {
  const desktop = process.env.XDG_CURRENT_DESKTOP?.toLowerCase().split(":") ?? [];
  return process.env.KDE_FULL_SESSION?.toLowerCase() === "true" || desktop.includes("kde");
}
async function readKWalletPassword(config) {
  if (!isKdeSession() || !config.kwalletFolder || !config.kwalletEntry) return { value: null };
  const result = await readLinuxCommandPassword("kwallet-query", ["-f", config.kwalletFolder, "-r", config.kwalletEntry, "kdewallet"]);
  return {
    value: result.value,
    source: result.value ? "kwallet" : void 0,
    ...result.failed ? { warning: `Could not read ${config.name} KWallet cookie encryption password` } : {}
  };
}
async function readLinuxPassword(config) {
  if (!config.secretToolApp) return { value: "peanuts", cacheable: false };
  const secretService = await readLinuxCommandPassword("secret-tool", ["lookup", "application", config.secretToolApp]);
  if (secretService.value) return { value: secretService.value, source: "secret-service", cacheable: true };
  const kwallet = await readKWalletPassword(config);
  if (kwallet.value) return { ...kwallet, cacheable: true };
  return { value: "peanuts", warning: kwallet.warning, cacheable: false };
}
async function importSqlite() {
  if (process.env.PI_WEB_ACCESS_DISABLE_NODE_SQLITE === "1") return null;
  if (sqliteImportAttempted) return sqliteModule;
  sqliteImportAttempted = true;
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((warning, ...args) => {
    const msg = typeof warning === "string" ? warning : warning?.message ?? "";
    if (msg.includes("SQLite is an experimental feature")) return;
    return orig(warning, ...args);
  });
  try {
    sqliteModule = await import("node:sqlite");
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = orig;
  }
  return sqliteModule;
}
async function runSqliteQuery(dbPath, sql) {
  const sqlite = await importSqlite();
  let queryFailed = false;
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        return { status: "success", rows: db.prepare(sql).all() };
      } finally {
        db.close();
      }
    } catch {
      queryFailed = true;
    }
  }
  const cli = await runSqliteCli(dbPath, sql);
  if (cli.status === "success") return cli;
  if (cli.failure === "query") queryFailed = true;
  const python = await runPythonSqlite(dbPath, sql);
  if (python.status === "success") return python;
  if (python.failure === "query") queryFailed = true;
  return { status: "failure", failure: queryFailed ? "query" : "unavailable" };
}
function runSqliteCli(dbPath, sql) {
  return new Promise((resolve) => {
    execFile3("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 5e3, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "[]");
        resolve(Array.isArray(parsed) ? { status: "success", rows: parsed } : { status: "failure", failure: "query" });
      } catch {
        resolve({ status: "failure", failure: "query" });
      }
    });
  });
}
function runPythonSqlite(dbPath, sql) {
  const script = "import json,sqlite3,sys\ntry:\n c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\n c.row_factory=sqlite3.Row\n print(json.dumps([dict(r) for r in c.execute(sys.argv[2]).fetchall()]))\nexcept Exception:\n sys.exit(1)";
  return new Promise((resolve) => {
    execFile3("python3", ["-c", script, dbPath, sql], { timeout: 5e3, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "[]");
        resolve(Array.isArray(parsed) ? { status: "success", rows: parsed } : { status: "failure", failure: "query" });
      } catch {
        resolve({ status: "failure", failure: "query" });
      }
    });
  });
}
async function readMetaVersion(dbPath) {
  const result = await runSqliteQuery(dbPath, "SELECT value FROM meta WHERE key = 'version'");
  if (result.status === "failure") {
    return result.failure === "unavailable" ? { value: null, failure: result.failure } : { value: 0 };
  }
  const value = result.rows[0]?.value;
  if (typeof value === "number") return { value: Math.floor(value) };
  if (typeof value === "string") return { value: parseInt(value, 10) || 0 };
  return { value: 0 };
}
async function hasCookieNames(dbPath, hosts, names) {
  const result = await runSqliteQuery(dbPath, `SELECT DISTINCT name FROM cookies WHERE ${buildCookieWhere(hosts, names)}`);
  if (result.status === "failure") return { present: false, failure: result.failure };
  const present = new Set(result.rows.map((row) => typeof row.name === "string" ? row.name : ""));
  return { present: names.every((name) => present.has(name)) };
}
async function queryCookieRows(dbPath, hosts, names, filterExpired) {
  const columns = await readCookieColumns(dbPath);
  if (columns.status === "failure") return columns;
  const pathExpr = columns.columns.has("path") ? "path" : "'/' AS path";
  const expiresExpr = columns.columns.has("expires_utc") ? chromeExpiryMillisExpr() : "0";
  const expiryFilter = filterExpired && columns.columns.has("expires_utc") ? ` AND (${expiresExpr} = 0 OR ${expiresExpr} > ${chromeExpiryNowMillis()})` : "";
  const partitionFilter = filterExpired ? unpartitionedCookieFilter(columns.columns) : "";
  return runSqliteQuery(
    dbPath,
    `SELECT name, value, ${pathExpr}, ${expiresExpr} AS expires_utc, hex(encrypted_value) AS encrypted_value_hex FROM cookies WHERE ${buildCookieWhere(hosts, names ?? void 0)}${expiryFilter}${partitionFilter} ORDER BY length(path) DESC, ${expiresExpr} ASC`
  );
}
async function readCookieColumns(dbPath) {
  const result = await runSqliteQuery(dbPath, "PRAGMA table_info(cookies)");
  if (result.status === "failure") return result;
  return { status: "success", columns: new Set(result.rows.map((row) => typeof row.name === "string" ? row.name : "")) };
}
function chromeExpiryMillisExpr() {
  return "CASE WHEN expires_utc = 0 THEN 0 ELSE CAST(expires_utc / 1000 AS INTEGER) + CASE WHEN expires_utc % 1000 = 0 THEN 0 ELSE 1 END END";
}
function chromeExpiryNowMillis() {
  return Date.now() + 116444736e5;
}
function unpartitionedCookieFilter(columns) {
  const clauses = [];
  if (columns.has("top_frame_site_key")) clauses.push("(top_frame_site_key IS NULL OR top_frame_site_key = '')");
  if (columns.has("partition_key")) clauses.push("(partition_key IS NULL OR partition_key = '')");
  if (columns.has("is_partitioned")) clauses.push("(is_partitioned IS NULL OR is_partitioned = 0)");
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}
function buildCookieHeader(entries) {
  return entries.sort((a, b) => b.path.length - a.path.length).map(({ name, value }) => `${name}=${value}`).join("; ");
}
function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath[cookiePath.length] === "/";
}
function buildCookieWhere(hosts, cookieNames) {
  const hostClauses = [];
  for (const host of hosts) {
    const escapedHost = escapeSqlString(host);
    hostClauses.push(`host_key = '${escapedHost}'`);
    for (const candidate of domainCookieHosts(host)) {
      hostClauses.push(`host_key = '.${escapeSqlString(candidate)}'`);
    }
  }
  let where = `(${[...new Set(hostClauses)].join(" OR ")})`;
  const names = cookieNames ? [...cookieNames].filter(Boolean) : [];
  if (names.length) where += ` AND name IN (${names.map((name) => `'${escapeSqlString(name)}'`).join(", ")})`;
  return where;
}
function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}
function domainCookieHosts(host) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return [];
  const candidates = /* @__PURE__ */ new Set();
  for (let i = 0; i <= parts.length - 2; i++) candidates.add(parts.slice(i).join("."));
  return [...candidates];
}
function copySidecar(srcDb, targetDb, suffix) {
  const sidecar = `${srcDb}${suffix}`;
  if (!existsSync2(sidecar)) return;
  try {
    copyFileSync(sidecar, `${targetDb}${suffix}`);
  } catch {
  }
}

// src/pi-web-access/utils.ts
function normalizeSearchBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
function isValidHeaderValue(value) {
  try {
    new Headers({ "x-pi-web-access-validation": value });
    return true;
  } catch {
    return false;
  }
}
function normalizeSearchHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") continue;
    const name = key.trim();
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    if (!isValidHeaderValue(headerValue)) continue;
    headers[name] = headerValue.trim();
  }
  return headers;
}
function resolveApiBaseUrl(options) {
  const fromEnvironment = options.environmentValue !== void 0;
  const value = fromEnvironment ? options.environmentValue : options.configuredValue;
  if (value === void 0) return options.defaultValue;
  const source = fromEnvironment ? options.environmentKey : `webAccess.${options.configKey} in ${webPreferencesPath()}`;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${source} must be an absolute HTTP(S) URL`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${source} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "https:" && (url.protocol !== "http:" || !isLoopbackHostname(url.hostname))) {
    throw new Error(`${source} must be an absolute HTTPS URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${source} must not include credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${source} must not include query parameters or fragments`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}
var API_REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var API_REQUEST_BODY_HEADERS = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"];
var MAX_API_REDIRECTS = 5;
async function fetchWithCredentialRedirects(url, init, credentialHeaders, credentialQueryParameters = []) {
  let current = new URL(url);
  let requestInit = init;
  for (let redirects = 0; ; redirects++) {
    const response = await webFetch(current, { ...requestInit, redirect: "manual" });
    if (!API_REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_API_REDIRECTS) {
      throw new Error(`Too many API redirects from ${url}`);
    }
    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`API redirect from ${current.origin} must use HTTP(S)`);
    }
    const method = requestInit.method?.toUpperCase() ?? "GET";
    if ((response.status === 301 || response.status === 302) && method === "POST" || response.status === 303 && method !== "GET" && method !== "HEAD") {
      const headers = new Headers(requestInit.headers);
      for (const name of API_REQUEST_BODY_HEADERS) headers.delete(name);
      const { body: _body, ...withoutBody } = requestInit;
      requestInit = { ...withoutBody, method: "GET", headers };
    }
    if (next.origin !== current.origin) {
      for (const name of credentialQueryParameters) next.searchParams.delete(name);
      const headers = new Headers(requestInit.headers);
      for (const name of credentialHeaders) headers.delete(name);
      requestInit = { ...requestInit, headers };
    }
    current = next;
  }
}
var GOOGLE_RECENCY_TBS = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y"
};

// src/pi-web-access/domain-filter-normalization.ts
function normalizeDomain(value) {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("-")) input = input.slice(1).trim();
  if (!input) return null;
  try {
    const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    input = parsed.hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}
function normalizeDomainFilters(domainFilter) {
  const filters = { include: [], exclude: [] };
  for (const raw of domainFilter ?? []) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const target = raw.trim().startsWith("-") ? filters.exclude : filters.include;
    if (!target.includes(domain)) target.push(domain);
  }
  return filters;
}
function buildSiteFilteredQuery(query, filters) {
  const parts = [query];
  if (filters.include.length === 1) parts.push(`site:${filters.include[0]}`);
  if (filters.include.length > 1) parts.push(`(${filters.include.map((domain) => `site:${domain}`).join(" OR ")})`);
  for (const domain of filters.exclude) parts.push(`-site:${domain}`);
  return parts.join(" ");
}
function matchesDomainFilter(url, filters) {
  if (filters.include.length === 0 && filters.exclude.length === 0) return true;
  let hostname;
  try {
    hostname = (typeof url === "string" ? new URL(url) : url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return false;
  }
  const matches = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);
  if (filters.exclude.some(matches)) return false;
  return filters.include.length === 0 || filters.include.some(matches);
}

// src/pi-web-access/parallel.ts
var PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
var PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
var CONFIG_PATH = webCredentialsPath();
var MIN_PARALLEL_API_KEY_LENGTH = 8;
var MIN_USEFUL_CONTENT = 500;
var SEARCH_TIMEOUT_MS = 6e4;
var PLACEHOLDER_API_KEY_DENYLIST = /* @__PURE__ */ new Set([
  "replace_with_your_parallel_api_key",
  "parallel_api_key",
  "your-key",
  "your-key-here",
  "your-api-key-here",
  "dummy",
  "placeholder",
  "changeme",
  "insert-your-key",
  "insert-your-key-here",
  "api-key",
  "xxx"
]);
var cachedConfig3 = null;
function loadConfig2() {
  return cachedConfig3 ??= loadWebAccessConfig();
}
function normalizeApiKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
function isPlaceholderApiKey(key) {
  const normalized = key.trim();
  return normalized.length < MIN_PARALLEL_API_KEY_LENGTH || PLACEHOLDER_API_KEY_DENYLIST.has(normalized.toLowerCase());
}
async function resolveParallelApiKey(signal) {
  const configKey = normalizeApiKey(loadConfig2().parallelApiKey);
  if (configKey?.startsWith("$") || configKey?.startsWith("!")) {
    const resolved = await resolveCredential({
      provider: "Parallel",
      configuredValue: configKey,
      environmentValue: process.env.PARALLEL_API_KEY,
      signal
    });
    return resolved && !isPlaceholderApiKey(resolved) ? resolved : null;
  }
  const envKey = normalizeApiKey(process.env.PARALLEL_API_KEY);
  if (envKey && !isPlaceholderApiKey(envKey)) return envKey;
  if (configKey && !isPlaceholderApiKey(configKey)) return configKey;
  return null;
}
function hasConfiguredApiKey() {
  const configKey = normalizeApiKey(loadConfig2().parallelApiKey);
  if (configKey?.startsWith("$") || configKey?.startsWith("!")) {
    return hasCredentialSource({
      provider: "Parallel",
      configuredValue: configKey,
      environmentValue: process.env.PARALLEL_API_KEY
    });
  }
  const envKey = normalizeApiKey(process.env.PARALLEL_API_KEY);
  return envKey !== null && !isPlaceholderApiKey(envKey) || configKey !== null && !isPlaceholderApiKey(configKey);
}
async function getApiKey(signal) {
  const key = await resolveParallelApiKey(signal);
  if (!key) {
    throw new Error(
      `Parallel API key not found. Either:
  1. Create ${CONFIG_PATH} with { "parallelApiKey": "your-key" }
  2. Set PARALLEL_API_KEY environment variable
Get a key at https://platform.parallel.ai`
    );
  }
  return key;
}
function hasParallelApiKey() {
  return hasConfiguredApiKey();
}
function isParallelAvailable() {
  return hasParallelApiKey();
}
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function activityContext(url, body) {
  if (typeof body.objective === "string" && body.objective.trim().length > 0) {
    return { type: "api", query: body.objective };
  }
  const searchQueries = body.search_queries;
  if (Array.isArray(searchQueries) && typeof searchQueries[0] === "string") {
    return { type: "api", query: searchQueries[0] };
  }
  const urls = body.urls;
  if (Array.isArray(urls) && typeof urls[0] === "string") {
    return { type: "fetch", url: urls[0] };
  }
  return url.includes("/search") ? { type: "api", query: "Parallel search" } : { type: "fetch", url };
}
function recencyToAfterDate(filter) {
  const now = /* @__PURE__ */ new Date();
  const offsets = { day: 1, week: 7, month: 30, year: 365 };
  const days = offsets[filter] ?? 0;
  return new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
}
function mapDomainFilter(domainFilter) {
  const { include, exclude } = normalizeDomainFilters(domainFilter);
  return {
    ...include.length ? { include_domains: include } : {},
    ...exclude.length ? { exclude_domains: exclude } : {}
  };
}
function buildSearchRequestBody(query, options = {}) {
  const numResults = Math.max(1, Math.min(Math.floor(options.numResults ?? 5), 20));
  const sourcePolicy = {
    ...mapDomainFilter(options.domainFilter),
    ...options.recencyFilter ? { after_date: recencyToAfterDate(options.recencyFilter) } : {}
  };
  return {
    objective: query,
    search_queries: [query],
    advanced_settings: {
      max_results: numResults,
      ...Object.keys(sourcePolicy).length > 0 ? { source_policy: sourcePolicy } : {}
    }
  };
}
function normalizeExcerpts(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}
function mapSearchResponse(results, includeContent) {
  const response = { answer: "", results: [] };
  if (!Array.isArray(results)) return response;
  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item?.url) continue;
    const excerpts2 = normalizeExcerpts(item.excerpts);
    const title = item.title || `Source ${i + 1}`;
    response.results.push({
      title,
      url: item.url,
      snippet: excerpts2.length > 0 ? excerpts2[0].replace(/\s+/g, " ").trim().slice(0, 200) : ""
    });
    if (excerpts2.length === 0) continue;
    parts.push(`${excerpts2.join(" ")}
Source: ${title} (${item.url})`);
    if (includeContent) {
      (response.inlineContent ??= []).push({
        url: item.url,
        title: item.title || "",
        content: excerpts2.join("\n\n"),
        error: null
      });
    }
  }
  response.answer = parts.join("\n\n");
  return response;
}
function resolveExtractContent(result) {
  const fullContent = typeof result.full_content === "string" ? result.full_content.trim() : "";
  return fullContent.length > 0 ? fullContent : normalizeExcerpts(result.excerpts).join("\n\n");
}
function mapExtractResult(result) {
  if (!result?.url) return null;
  const content = resolveExtractContent(result);
  if (content.length < MIN_USEFUL_CONTENT) return null;
  return {
    url: result.url,
    title: typeof result.title === "string" ? result.title.trim() : "",
    content,
    error: null
  };
}
function buildExtractRequestBody(url, options = {}, fullContent = false) {
  const body = { urls: [url] };
  const prompt = options.prompt?.trim();
  if (prompt) body.objective = prompt;
  if (fullContent) body.advanced_settings = { full_content: true };
  return body;
}
function findExtractResult(results, url) {
  if (!Array.isArray(results)) return void 0;
  return results.find((item) => item?.url === url) ?? results[0];
}
function hasExtractUrlError(errors, url) {
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => {
    if (typeof entry === "string") return entry === url;
    return typeof entry === "object" && entry !== null && entry.url === url;
  });
}
async function fetchAndMapExtractResult(url, body, signal) {
  const data = await parallelFetch(PARALLEL_EXTRACT_URL, body, signal);
  if (hasExtractUrlError(data.errors, url)) return { mapped: null, result: void 0 };
  const result = findExtractResult(data.results, url);
  return { mapped: mapExtractResult(result), result };
}
async function searchWithParallel(query, options = {}) {
  const data = await parallelFetch(PARALLEL_SEARCH_URL, buildSearchRequestBody(query, options), options.signal);
  return mapSearchResponse(data.results, options.includeContent);
}
async function extractWithParallel(url, signal, options = {}) {
  const initial = await fetchAndMapExtractResult(url, buildExtractRequestBody(url, options), signal);
  if (initial.mapped) return initial.mapped;
  if (!initial.result || resolveExtractContent(initial.result).length >= MIN_USEFUL_CONTENT) return null;
  const retry = await fetchAndMapExtractResult(url, buildExtractRequestBody(url, options, true), signal);
  return retry.mapped;
}
async function parallelFetch(url, body, signal) {
  const apiKey = await getApiKey(signal);
  const activityId = activityMonitor.logStart(activityContext(url, body));
  let response;
  try {
    response = await fetchWithCredentialRedirects(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: requestSignal(signal)
    }, ["x-api-key"]);
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
  if (!response.ok) {
    activityMonitor.logComplete(activityId, response.status);
    const errorText = redactCredential(await response.text(), apiKey);
    throw new SearchHttpError(response.status, `Parallel API error ${response.status}: ${errorText.slice(0, 300)}`);
  }
  try {
    const data = await response.json();
    activityMonitor.logComplete(activityId, response.status);
    return data;
  } catch (err) {
    activityMonitor.logComplete(activityId, response.status);
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error("Parallel API returned invalid JSON");
  }
}

// src/pi-web-access/parallel-mcp.ts
var PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
var CONFIG_PATH2 = webCredentialsPath();
var REQUEST_TIMEOUT_MS = 6e4;
function requestSignal2(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function filterResults(results, domainFilter) {
  if (!domainFilter?.length) return results;
  const filters = normalizeDomainFilters(domainFilter);
  return results.filter((result) => URL.canParse(result.url) && matchesDomainFilter(result.url, filters));
}
function buildSearchQuery(query, options) {
  const parts = [query];
  for (const raw of options.domainFilter ?? []) {
    const domain = normalizeDomain(raw);
    if (domain) parts.push(raw.trim().startsWith("-") ? `-site:${domain}` : `site:${domain}`);
  }
  if (options.recencyFilter) {
    const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
    parts.push(labels[options.recencyFilter]);
  }
  return parts.join(" ");
}
async function callParallelMcp(toolName, args, signal) {
  const apiKey = await resolveParallelApiKey(signal);
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    // Parallel's free tier rate-limits the default "undici" User-Agent.
    "User-Agent": "pi-web-access"
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response;
  try {
    response = await webFetch(PARALLEL_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
      signal: requestSignal2(signal)
    });
  } catch (err) {
    const message = apiKey ? redactCredential(errorMessage(err), apiKey) : errorMessage(err);
    if (message === errorMessage(err)) throw err;
    throw new Error(message);
  }
  const body = await response.text();
  const safeBody = apiKey ? redactCredential(body, apiKey) : body;
  if (!response.ok) {
    if (response.status === 429) {
      throw new SearchHttpError(response.status, `Parallel MCP rate limit reached (429). Add parallelApiKey to ${CONFIG_PATH2} or set PARALLEL_API_KEY for higher limits: ${safeBody.slice(0, 200)}`);
    }
    throw new SearchHttpError(response.status, `Parallel MCP error ${response.status}: ${safeBody.slice(0, 300)}`);
  }
  let parsed = null;
  for (const candidateText of [...body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()), body]) {
    if (!candidateText) continue;
    try {
      const candidate = JSON.parse(candidateText);
      if (candidate.result || candidate.error) {
        parsed = candidate;
        break;
      }
    } catch {
    }
  }
  if (!parsed) throw new Error("Parallel MCP returned invalid JSON-RPC content");
  if (parsed.error) {
    const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
    const message = apiKey ? redactCredential(parsed.error.message || "Unknown error", apiKey) : parsed.error.message || "Unknown error";
    throw new Error(`Parallel MCP error${code}: ${message}`);
  }
  if (parsed.result?.isError) {
    const text2 = parsed.result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.trim() || "Parallel MCP returned an error";
    throw new Error(apiKey ? redactCredential(text2, apiKey) : text2);
  }
  if (parsed.result?.structuredContent && typeof parsed.result.structuredContent === "object") return parsed.result.structuredContent;
  const text = parsed.result?.content?.find((item) => item.type === "text" && typeof item.text === "string" && item.text.trim())?.text;
  if (!text) throw new Error("Parallel MCP returned empty content");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function parseTextResults(text) {
  return text.split(/(?=^Title: )/m).flatMap((block) => {
    const url = block.match(/^URL: (.+)/m)?.[1]?.trim();
    if (!url) return [];
    const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
    const textStart = block.indexOf("\nText: ");
    const excerpt = textStart >= 0 ? block.slice(textStart + 7).replace(/\n---\s*$/, "").trim() : "";
    return [{ url, title, excerpts: excerpt ? [excerpt] : [] }];
  });
}
function getResults(payload) {
  if (typeof payload === "string") return parseTextResults(payload);
  if (!payload || typeof payload !== "object") return [];
  const results = payload.results;
  if (!Array.isArray(results)) return [];
  return results.filter((item) => !!item && typeof item === "object" && typeof item.url === "string");
}
function excerpts(result) {
  return Array.isArray(result.excerpts) ? result.excerpts.filter((item) => typeof item === "string" && item.trim()) : [];
}
function isParallelMcpAvailable() {
  return true;
}
async function searchWithParallelMcp(query, options = {}) {
  const activityId = activityMonitor.logStart({ type: "api", query });
  try {
    const searchQuery = buildSearchQuery(query, options);
    const payload = await callParallelMcp("web_search", { objective: query, search_queries: [searchQuery] }, options.signal);
    const maxResults = Math.max(1, Math.min(Math.floor(options.numResults ?? 5), 20));
    const results = filterResults(getResults(payload), options.domainFilter).slice(0, maxResults);
    activityMonitor.logComplete(activityId, 200);
    const response = { answer: "", results: [] };
    const parts = [];
    for (const [index, result] of results.entries()) {
      const texts = excerpts(result);
      const title = result.title || `Source ${index + 1}`;
      const content = texts.join(" ").trim();
      if (content) parts.push(`${content}
Source: ${title} (${result.url})`);
      response.results.push({
        title,
        url: result.url,
        snippet: texts[0]?.replace(/\s+/g, " ").trim().slice(0, 200) ?? ""
      });
      if (options.includeContent && texts.length > 0) {
        (response.inlineContent ??= []).push({
          url: result.url,
          title: result.title || "",
          content: texts.join("\n\n"),
          error: null
        });
      }
    }
    response.answer = parts.join("\n\n");
    return response;
  } catch (err) {
    const message = errorMessage(err);
    if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, message);
    throw err;
  }
}
async function extractWithParallelMcp(url, signal, options = {}) {
  const activityId = activityMonitor.logStart({ type: "fetch", url });
  try {
    const objective = options.prompt?.trim();
    const payload = await callParallelMcp("web_fetch", {
      urls: [url],
      ...objective ? { objective: objective.slice(0, 200) } : {},
      full_content: true
    }, signal);
    const results = getResults(payload);
    const result = results.find((item) => item.url === url) ?? results[0];
    if (!result) {
      activityMonitor.logComplete(activityId, 200);
      return null;
    }
    const fullContent = typeof result.full_content === "string" ? result.full_content.trim() : "";
    const content = fullContent || excerpts(result).join("\n\n");
    activityMonitor.logComplete(activityId, 200);
    return content ? { url: result.url, title: result.title || "", content, error: null } : null;
  } catch (err) {
    const message = errorMessage(err);
    if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, message);
    throw err;
  }
}

// src/pi-web-access/search-answer-formatting.ts
function extractSnippetAround(text, start, end) {
  if (typeof start !== "number" || typeof end !== "number" || !text) return "";
  const before = Math.max(0, start - 100);
  const after = Math.min(text.length, end + 100);
  const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}
function extractAnswer(output) {
  const parts = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = part.text;
      if (typeof text === "string" && text.trim().length > 0) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}
function normalizeSearchText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
function formatSearchResultAsAnswer({ title, url, snippet }, summary = snippet) {
  const source = `Source: ${title} (${url})`;
  return summary ? `${summary}
${source}` : source;
}
function formatSearchResultsAsAnswer(results) {
  return results.map((result) => formatSearchResultAsAnswer(result)).join("\n\n");
}

// src/pi-web-access/search-result-count-normalization.ts
function normalizeSearchResultCount(value, options = {}) {
  const count = typeof value === "number" && Number.isFinite(value) ? value : 5;
  return Math.max(1, Math.min(Math.floor(count), options.max ?? 20));
}

// src/pi-web-access/tinyfish.ts
var TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
var TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";
var CONFIG_PATH3 = webCredentialsPath();
var SEARCH_TIMEOUT_MS2 = 6e4;
var FETCH_TIMEOUT_MS = 15e4;
var MAX_FETCH_URLS = 10;
var MAX_FETCH_PER_URL_TIMEOUT_MS = 11e4;
var cachedConfig4 = null;
function loadConfig3() {
  return cachedConfig4 ??= loadWebAccessConfig();
}
async function getApiKey2(signal) {
  const key = await resolveCredential({
    provider: "TinyFish",
    configuredValue: loadConfig3().tinyfishApiKey,
    environmentValue: process.env.TINYFISH_API_KEY,
    signal
  });
  if (!key) {
    throw new Error(
      `TinyFish API key not found. Either:
  1. Create ${CONFIG_PATH3} with { "tinyfishApiKey": "your-key" }
  2. Set TINYFISH_API_KEY environment variable
Get a key at https://agent.tinyfish.ai/api-keys`
    );
  }
  return key;
}
function isTinyFishAvailable() {
  return hasCredentialSource({
    provider: "TinyFish",
    configuredValue: loadConfig3().tinyfishApiKey,
    environmentValue: process.env.TINYFISH_API_KEY
  });
}
function requestSignal3(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function recencyMinutes(filter) {
  if (!filter) return void 0;
  const minutes = {
    day: 1440,
    week: 10080,
    month: 43200,
    year: 525600
  };
  return minutes[filter];
}
function buildSearchUrl(query, options, page) {
  const params = new URLSearchParams({ query });
  const { include: includeDomains, exclude: excludeDomains } = normalizeDomainFilters(options.domainFilter);
  if (includeDomains.length > 0) params.set("include_domains", includeDomains.join(","));
  if (excludeDomains.length > 0) params.set("exclude_domains", excludeDomains.join(","));
  const recency = recencyMinutes(options.recencyFilter);
  if (recency !== void 0) params.set("recency_minutes", String(recency));
  if (page > 0) params.set("page", String(page));
  return `${TINYFISH_SEARCH_URL}?${params.toString()}`;
}
async function tinyFishJsonRequest(label, url, apiKey, init, timeoutMs, signal) {
  let response;
  try {
    response = await fetchWithCredentialRedirects(url, {
      ...init,
      headers: {
        "X-API-Key": apiKey,
        ...init.body ? { "Content-Type": "application/json" } : {},
        ...init.headers
      },
      signal: requestSignal3(signal, timeoutMs)
    }, ["X-API-Key", "Authorization", "Cookie"]);
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new SearchHttpError(response.status, `TinyFish ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`TinyFish ${label} API returned invalid JSON`);
  }
}
function mapSearchResults(results) {
  return results.flatMap((item) => {
    if (!item || typeof item.url !== "string" || item.url.trim().length === 0) return [];
    const url = item.url.trim();
    return [{
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
      url,
      snippet: typeof item.snippet === "string" ? item.snippet.replace(/\s+/g, " ").trim() : ""
    }];
  });
}
function deduplicateResults(results, limit) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    unique.push(result);
    if (unique.length >= limit) break;
  }
  return unique;
}
function fetchPerUrlTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_FETCH_PER_URL_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(value), MAX_FETCH_PER_URL_TIMEOUT_MS));
}
function fetchBody(urls, options = {}) {
  const body = {
    urls,
    format: "markdown",
    per_url_timeout_ms: fetchPerUrlTimeout(options.timeoutMs)
  };
  const purpose = options.prompt?.trim();
  if (purpose) body.purpose = purpose.slice(0, 2e3);
  return body;
}
function findFetchError(errors, url) {
  if (!Array.isArray(errors)) return void 0;
  return errors.find((item) => item?.url === url) ?? errors[0];
}
function fetchResultContent(result) {
  if (typeof result.text === "string") return result.text.trim();
  if (result.text && typeof result.text === "object") return JSON.stringify(result.text, null, 2);
  return "";
}
function mapFetchResult(result, requestedUrl) {
  if (!result) return null;
  const content = fetchResultContent(result);
  if (!content) return null;
  return {
    url: requestedUrl,
    title: typeof result.title === "string" ? result.title.trim() : "",
    content,
    error: null
  };
}
async function fetchBatch(urls, apiKey, signal, options = {}) {
  return tinyFishJsonRequest(
    "Fetch",
    TINYFISH_FETCH_URL,
    apiKey,
    { method: "POST", body: JSON.stringify(fetchBody(urls, options)) },
    FETCH_TIMEOUT_MS,
    signal
  );
}
async function fetchInlineContent(urls, apiKey, signal) {
  const content = [];
  for (let offset = 0; offset < urls.length; offset += MAX_FETCH_URLS) {
    const batch = urls.slice(offset, offset + MAX_FETCH_URLS);
    const data = await fetchBatch(batch, apiKey, signal);
    if (!Array.isArray(data.results) || !Array.isArray(data.errors)) {
      throw new Error("TinyFish Fetch API returned an unexpected response shape");
    }
    for (const url of batch) {
      const result = data.results.find((item) => item?.url === url || item?.final_url === url);
      const mapped = mapFetchResult(result, url);
      if (mapped) content.push(mapped);
    }
  }
  return content;
}
async function searchWithTinyFish(query, options = {}) {
  const apiKey = await getApiKey2(options.signal);
  const numResults = normalizeSearchResultCount(options.numResults);
  const activityId = activityMonitor.logStart({ type: "api", query });
  try {
    const combined = [];
    const pages = numResults > 10 ? 2 : 1;
    for (let page = 0; page < pages; page++) {
      const data = await tinyFishJsonRequest(
        "Search",
        buildSearchUrl(query, options, page),
        apiKey,
        { method: "GET" },
        SEARCH_TIMEOUT_MS2,
        options.signal
      );
      if (!Array.isArray(data.results)) throw new Error("TinyFish Search API returned an unexpected response shape");
      combined.push(...mapSearchResults(data.results));
      if (data.results.length < 10) break;
    }
    const domains = normalizeDomainFilters(options.domainFilter);
    const results = deduplicateResults(combined.filter((result) => matchesDomainFilter(result.url, domains)), numResults);
    const response = { answer: formatSearchResultsAsAnswer(results), results };
    if (options.includeContent && results.length > 0) {
      const inlineContent = await fetchInlineContent(results.map((result) => result.url), apiKey, options.signal);
      if (inlineContent.length > 0) response.inlineContent = inlineContent;
    }
    activityMonitor.logComplete(activityId, 200);
    return response;
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
}
async function extractWithTinyFish(url, signal, options = {}) {
  const apiKey = await getApiKey2(signal);
  const activityId = activityMonitor.logStart({ type: "fetch", url });
  try {
    const data = await fetchBatch([url], apiKey, signal, options);
    if (!Array.isArray(data.results) || !Array.isArray(data.errors)) {
      throw new Error("TinyFish Fetch API returned an unexpected response shape");
    }
    const result = data.results.find((item) => item?.url === url || item?.final_url === url) ?? data.results[0];
    const mapped = mapFetchResult(result, url);
    if (mapped) {
      activityMonitor.logComplete(activityId, 200);
      return mapped;
    }
    const fetchError = findFetchError(data.errors, url);
    if (fetchError) {
      const status = typeof fetchError.status === "number" ? ` (HTTP ${fetchError.status})` : "";
      throw new Error(`TinyFish Fetch failed for ${url}: ${fetchError.error || "unknown error"}${status}`);
    }
    activityMonitor.logComplete(activityId, 200);
    return null;
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
}

// src/pi-web-access/search1api.ts
var SEARCH1API_SEARCH_URL = "https://api.search1api.com/search";
var SEARCH1API_CRAWL_URL = "https://api.search1api.com/crawl";
var CONFIG_PATH4 = webCredentialsPath();
var SEARCH_TIMEOUT_MS3 = 6e4;
var CRAWL_TIMEOUT_MS = 6e4;
var cachedConfig5 = null;
function loadConfig4() {
  return cachedConfig5 ??= loadWebAccessConfig();
}
async function getApiKey3(signal) {
  const key = await resolveCredential({
    provider: "Search1API",
    configuredValue: loadConfig4().search1apiApiKey,
    environmentValue: process.env.SEARCH1API_KEY,
    signal
  });
  if (!key) {
    throw new Error(
      `Search1API key not found. Either:
  1. Create ${CONFIG_PATH4} with { "search1apiApiKey": "your-key" }
  2. Set SEARCH1API_KEY environment variable
Create a key at https://dashboard.search1api.com`
    );
  }
  return key;
}
function isSearch1APIAvailable() {
  return hasCredentialSource({
    provider: "Search1API",
    configuredValue: loadConfig4().search1apiApiKey,
    environmentValue: process.env.SEARCH1API_KEY
  });
}
function requestSignal4(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function buildSearchBody(query, options) {
  const numResults = normalizeSearchResultCount(options.numResults);
  const { include: includeSites, exclude: excludeSites } = normalizeDomainFilters(options.domainFilter);
  return {
    query,
    max_results: numResults,
    crawl_results: options.includeContent ? numResults : 0,
    ...includeSites.length > 0 ? { include_sites: includeSites } : {},
    ...excludeSites.length > 0 ? { exclude_sites: excludeSites } : {},
    ...options.recencyFilter ? { time_range: options.recencyFilter } : {}
  };
}
async function search1APIJsonRequest(label, url, apiKey, body, timeoutMs, signal) {
  let response;
  try {
    response = await webFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: requestSignal4(signal, timeoutMs)
    });
  } catch (err) {
    throw redactSearchFailure(err, apiKey).error;
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new SearchHttpError(response.status, `Search1API ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Search1API ${label} API returned invalid JSON`);
  }
}
function mapSearchResults2(results) {
  if (!Array.isArray(results)) {
    throw new Error("Search1API Search API returned an unexpected response shape");
  }
  return results.flatMap((item) => {
    if (!item || typeof item.link !== "string" || item.link.trim().length === 0) return [];
    const url = item.link.trim();
    return [{
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
      url,
      snippet: typeof item.snippet === "string" ? item.snippet.replace(/\s+/g, " ").trim() : ""
    }];
  });
}
function mapInlineContent(results) {
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    if (!item || typeof item.link !== "string" || item.link.trim().length === 0) return [];
    if (typeof item.content !== "string" || item.content.trim().length === 0) return [];
    return [{
      url: item.link.trim(),
      title: typeof item.title === "string" ? item.title.trim() : "",
      content: item.content,
      error: null
    }];
  });
}
async function searchWithSearch1API(query, options = {}) {
  const apiKey = await getApiKey3(options.signal);
  const activityId = activityMonitor.logStart({ type: "api", query });
  try {
    const data = await search1APIJsonRequest(
      "Search",
      SEARCH1API_SEARCH_URL,
      apiKey,
      buildSearchBody(query, options),
      SEARCH_TIMEOUT_MS3,
      options.signal
    );
    const results = mapSearchResults2(data.results);
    const response = { answer: formatSearchResultsAsAnswer(results), results };
    if (options.includeContent) {
      const inlineContent = mapInlineContent(data.results);
      if (inlineContent.length > 0) response.inlineContent = inlineContent;
    }
    activityMonitor.logComplete(activityId, 200);
    return response;
  } catch (err) {
    const failure = redactSearchFailure(err, apiKey);
    if (failure.message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, failure.message);
    throw failure.error;
  }
}
async function extractWithSearch1API(url, signal, options = {}) {
  const apiKey = await getApiKey3(signal);
  const activityId = activityMonitor.logStart({ type: "fetch", url });
  try {
    const data = await search1APIJsonRequest(
      "Crawl",
      SEARCH1API_CRAWL_URL,
      apiKey,
      { url },
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : CRAWL_TIMEOUT_MS,
      signal
    );
    const result = data.results;
    if (!result || typeof result !== "object") {
      throw new Error("Search1API Crawl API returned an unexpected response shape");
    }
    const content = typeof result.content === "string" ? result.content.trim() : "";
    if (!content) {
      activityMonitor.logComplete(activityId, 200);
      return null;
    }
    activityMonitor.logComplete(activityId, 200);
    return {
      url,
      title: typeof result.title === "string" ? result.title.trim() : "",
      content,
      error: null
    };
  } catch (err) {
    const failure = redactSearchFailure(err, apiKey);
    if (failure.message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, failure.message);
    throw failure.error;
  }
}

// src/pi-web-access/querit.ts
var QUERIT_SEARCH_URL = "https://api.querit.ai/v1/search";
var QUERIT_CONTENTS_URL = "https://api.querit.ai/v1/contents";
var CONFIG_PATH5 = webCredentialsPath();
var SEARCH_TIMEOUT_MS4 = 6e4;
var CONTENTS_TIMEOUT_MS = 6e4;
var MAX_CONTENT_URLS = 10;
var cachedConfig6 = null;
function loadConfig5() {
  return cachedConfig6 ??= loadWebAccessConfig();
}
async function getApiKey4(signal) {
  const key = await resolveCredential({
    provider: "Querit",
    configuredValue: loadConfig5().queritApiKey,
    environmentValue: process.env.QUERIT_API_KEY,
    signal
  });
  if (!key) {
    throw new Error(
      `Querit API key not found. Either:
  1. Create ${CONFIG_PATH5} with { "queritApiKey": "your-key" }
  2. Set QUERIT_API_KEY environment variable
Create a key at https://www.querit.ai/en/dashboard/api-keys`
    );
  }
  return key;
}
function isQueritAvailable() {
  return hasCredentialSource({
    provider: "Querit",
    configuredValue: loadConfig5().queritApiKey,
    environmentValue: process.env.QUERIT_API_KEY
  });
}
function requestSignal5(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function mapRecencyFilter(value) {
  if (value === "day") return "d1";
  if (value === "week") return "w1";
  if (value === "month") return "m1";
  if (value === "year") return "y1";
  return void 0;
}
function buildSearchBody2(query, options) {
  const { include, exclude } = normalizeDomainFilters(options.domainFilter);
  const date = mapRecencyFilter(options.recencyFilter);
  const filters = {};
  if (include.length > 0 || exclude.length > 0) {
    filters.sites = {
      ...include.length > 0 ? { include } : {},
      ...exclude.length > 0 ? { exclude } : {}
    };
  }
  if (date) filters.timeRange = { date };
  return {
    query,
    count: normalizeSearchResultCount(options.numResults),
    ...Object.keys(filters).length > 0 ? { filters } : {}
  };
}
function normalizeTimeoutMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return CONTENTS_TIMEOUT_MS;
  return Math.max(1, Math.floor(value));
}
function crawlTimeoutSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(Math.ceil(value / 1e3), 60));
}
function buildContentsBody(urls, options = {}) {
  return {
    urls,
    format: "markdown",
    crawlTimeout: crawlTimeoutSeconds(options.timeoutMs),
    extrasMeta: true
  };
}
async function queritJsonRequest(label, url, apiKey, body, timeoutMs, signal) {
  let response;
  try {
    response = await webFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: requestSignal5(signal, timeoutMs)
    });
  } catch (err) {
    const message = errorMessage(err);
    const isRequestAbort = err instanceof Error ? err.name === "AbortError" || err.name === "TimeoutError" || /abort|timeout/i.test(message) : /abort|timeout/i.test(message);
    if (!signal?.aborted && isRequestAbort) {
      const timeoutError = new Error(`Querit ${label} API request timed out after ${Math.ceil(timeoutMs / 1e3)} seconds`);
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new SearchHttpError(response.status, `Querit ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Querit ${label} API returned invalid JSON`);
  }
}
function assertApiSuccess(label, data) {
  const code = Number(data.error_code);
  if (!Number.isFinite(code) || code !== 200) {
    const renderedCode = data.error_code === void 0 ? "unknown" : String(data.error_code);
    const message = typeof data.error_msg === "string" && data.error_msg.trim() ? `: ${data.error_msg.trim()}` : "";
    throw new Error(`Querit ${label} API returned error ${renderedCode}${message}`);
  }
}
function mapSearchResults3(data) {
  const items = data.results?.result;
  if (!Array.isArray(items)) {
    throw new Error("Querit Search API returned an unexpected response shape");
  }
  return items.flatMap((item) => {
    if (!item || typeof item.url !== "string" || item.url.trim().length === 0) return [];
    const url = item.url.trim();
    return [{
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
      url,
      snippet: typeof item.snippet === "string" ? item.snippet.replace(/\s+/g, " ").trim() : ""
    }];
  });
}
function mapContentResult(result, requestedUrl) {
  if (!result || typeof result.content !== "string" || result.content.trim().length === 0) return null;
  const metadata = result.extrasMeta;
  return {
    url: requestedUrl,
    title: metadata && typeof metadata.title === "string" ? metadata.title.trim() : "",
    content: result.content.trim(),
    error: null
  };
}
function findContentResult(data, requestedUrl, index, requestedCount) {
  const exact = data.results.find((item) => item?.url === requestedUrl || item?.extrasMeta?.url === requestedUrl);
  if (exact) return exact;
  if (requestedCount === 1) return data.results[0];
  return data.results.length === requestedCount ? data.results[index] : void 0;
}
function failedContentStatus(data, result, index) {
  const status = result?.id ? data.statuses.find((item) => item?.id === result.id) : data.statuses[index];
  return status?.status === "failed";
}
async function fetchContentsBatch(urls, apiKey, signal, options = {}) {
  const data = await queritJsonRequest(
    "Contents",
    QUERIT_CONTENTS_URL,
    apiKey,
    buildContentsBody(urls, options),
    normalizeTimeoutMs(options.timeoutMs),
    signal
  );
  assertApiSuccess("Contents", data);
  if (!Array.isArray(data.results) || !Array.isArray(data.statuses)) {
    throw new Error("Querit Contents API returned an unexpected response shape");
  }
  return data;
}
async function fetchInlineContent2(urls, apiKey, signal) {
  const content = [];
  for (let offset = 0; offset < urls.length; offset += MAX_CONTENT_URLS) {
    const batch = urls.slice(offset, offset + MAX_CONTENT_URLS);
    const data = await fetchContentsBatch(batch, apiKey, signal);
    for (let index = 0; index < batch.length; index++) {
      const requestedUrl = batch[index];
      const result = findContentResult(data, requestedUrl, index, batch.length);
      const mapped = mapContentResult(result, requestedUrl);
      if (mapped) content.push(mapped);
    }
  }
  return content;
}
async function searchWithQuerit(query, options = {}) {
  const apiKey = await getApiKey4(options.signal);
  const activityId = activityMonitor.logStart({ type: "api", query });
  try {
    const data = await queritJsonRequest(
      "Search",
      QUERIT_SEARCH_URL,
      apiKey,
      buildSearchBody2(query, options),
      SEARCH_TIMEOUT_MS4,
      options.signal
    );
    assertApiSuccess("Search", data);
    const domains = normalizeDomainFilters(options.domainFilter);
    const results = mapSearchResults3(data).filter((result) => matchesDomainFilter(result.url, domains)).slice(0, normalizeSearchResultCount(options.numResults));
    const response = { answer: formatSearchResultsAsAnswer(results), results };
    if (options.includeContent && results.length > 0) {
      const inlineContent = await fetchInlineContent2(results.map((result) => result.url), apiKey, options.signal);
      if (inlineContent.length > 0) response.inlineContent = inlineContent;
    }
    activityMonitor.logComplete(activityId, 200);
    return response;
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (options.signal?.aborted) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
}
async function extractWithQuerit(url, signal, options = {}) {
  const apiKey = await getApiKey4(signal);
  const activityId = activityMonitor.logStart({ type: "fetch", url });
  try {
    const data = await fetchContentsBatch([url], apiKey, signal, options);
    const result = findContentResult(data, url, 0, 1);
    const mapped = mapContentResult(result, url);
    if (mapped) {
      activityMonitor.logComplete(activityId, 200);
      return mapped;
    }
    if (failedContentStatus(data, result, 0)) {
      throw new Error(`Querit Contents API failed to crawl ${url}`);
    }
    activityMonitor.logComplete(activityId, 200);
    return null;
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (signal?.aborted) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
}

// src/pi-web-access/ssrf-protection.ts
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
var DEFAULT_MAX_REDIRECTS = 5;
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var LOOPBACK_ALLOW_RANGES = ["127.0.0.0/8", "::1", "::ffff:127.0.0.0/104"];
var WEB_PREFERENCES_PATH = webPreferencesPath();
var DEFAULT_DOMAIN_POLICY = { allow: [], deny: [] };
function loadFetchContentDomainPolicy() {
  const parsed = loadWebAccessConfig();
  const fetchContent = parsed.fetchContent;
  if (fetchContent === void 0 || fetchContent === null) return { ...DEFAULT_DOMAIN_POLICY };
  if (typeof fetchContent !== "object" || Array.isArray(fetchContent)) {
    throw new Error(`fetchContent in ${WEB_PREFERENCES_PATH} must be an object`);
  }
  const policy = fetchContent.domainPolicy;
  if (policy === void 0 || policy === null) return { ...DEFAULT_DOMAIN_POLICY };
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error(`fetchContent.domainPolicy in ${WEB_PREFERENCES_PATH} must be an object`);
  }
  const config = policy;
  return {
    allow: parseDomainEntries(config.allow, "allow"),
    deny: parseDomainEntries(config.deny, "deny")
  };
}
function parseDomainEntries(value, field) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_PREFERENCES_PATH} must be an array of hostnames`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_PREFERENCES_PATH} must contain only hostnames; entry ${index + 1} is ${typeof entry}`);
    }
    const hostname = normalizeDomainEntry(entry);
    if (!hostname) {
      throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_PREFERENCES_PATH} contains an invalid hostname: ${JSON.stringify(entry)}`);
    }
    return hostname;
  });
}
function normalizeDomainEntry(entry) {
  const hostname = normalizeHostname(entry.trim());
  if (!hostname || /\s|[\\/?:#@]/.test(hostname)) return null;
  if (net.isIP(hostname)) return hostname;
  if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)) return null;
  return hostname;
}
function loadSsrfConfig() {
  const parsed = loadWebAccessConfig();
  const ssrf = parsed.ssrf;
  if (ssrf === void 0 || ssrf === null) return { allowRanges: [], trustEnvProxy: false };
  if (typeof ssrf !== "object" || Array.isArray(ssrf)) {
    throw new Error(`ssrf in ${WEB_PREFERENCES_PATH} must be an object`);
  }
  const config = ssrf;
  if (config.allowRanges !== void 0 && config.allowRanges !== null && !Array.isArray(config.allowRanges)) {
    throw new Error(`ssrf.allowRanges in ${WEB_PREFERENCES_PATH} must be an array of CIDR strings`);
  }
  if (config.trustEnvProxy !== void 0 && typeof config.trustEnvProxy !== "boolean") {
    throw new Error(`ssrf.trustEnvProxy in ${WEB_PREFERENCES_PATH} must be a boolean`);
  }
  const allowRangesValue = Array.isArray(config.allowRanges) ? config.allowRanges : [];
  const allowRanges = allowRangesValue.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`ssrf.allowRanges in ${WEB_PREFERENCES_PATH} must contain only CIDR strings; entry ${index + 1} is ${typeof entry}`);
    }
    return entry.trim();
  }).filter(Boolean);
  parseAllowRanges(allowRanges);
  return { allowRanges, trustEnvProxy: config.trustEnvProxy === true };
}
async function defaultLookup(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}
async function validateRemoteUrl(rawUrl, options = {}) {
  return (await resolveRemoteUrl(rawUrl, options)).url;
}
async function resolveRemoteUrl(rawUrl, options = {}) {
  const url = new URL(rawUrl.toString());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error("URL must include a hostname");
  const route = resolveWebProxy(url, options.proxy);
  if (hostname === "localhost") {
    if (options.allowLoopback === true) return {
      url,
      proxy: route.proxy,
      addresses: [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]
    };
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }
  if (hostname.endsWith(".localhost")) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }
  const allowRanges = parseAllowRanges(options.allowRanges);
  assertDomainPolicy(hostname, options.domainPolicy);
  if (net.isIP(hostname)) {
    const addressAllowRanges = options.allowLoopback === true ? [...allowRanges, ...parseAllowRanges(LOOPBACK_ALLOW_RANGES)] : allowRanges;
    assertPublicAddress(hostname, hostname, addressAllowRanges);
    return { url, proxy: route.proxy, addresses: [{ address: hostname, family: net.isIP(hostname) }] };
  }
  const trustProxy = options.trustEnvProxy === true && route.operatorControlled && route.remoteDns;
  if (trustProxy) return { url, proxy: route.proxy, addresses: void 0 };
  let addresses;
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = route.proxy && route.operatorControlled && route.remoteDns ? ". If your configured proxy resolves hostnames, set webAccess.ssrf.trustEnvProxy to true in metis-pi.toml." : "";
    throw new Error(`Failed to resolve ${hostname}: ${message}${hint}`);
  }
  if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  for (const { address } of addresses) {
    assertPublicAddress(address, hostname, allowRanges);
  }
  return { url, proxy: route.proxy, addresses: addresses.map(({ address }) => ({ address: normalizeHostname(address), family: net.isIP(normalizeHostname(address)) })) };
}
async function fetchRemoteUrl(url, init = {}, options = {}) {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const validationOptions = { ...options, proxy: options.proxy ?? init.__proxy };
  let resolved = await resolveRemoteUrl(url, validationOptions);
  const { Agent, fetch: undiciFetch } = await import("undici");
  const configuredOrigin = resolved.url.origin;
  let requestInit = init;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const current = resolved.url;
    if (options.beforeRequest) requestInit = await options.beforeRequest(new URL(current.toString()), requestInit);
    const addresses = resolved.addresses;
    const checkedHostname = normalizeHostname(current.hostname);
    const dispatcher = resolved.proxy === null && addresses?.length ? new Agent({ connect: {
      lookup(hostname, lookupOptions, callback) {
        if (normalizeHostname(hostname) !== checkedHostname) {
          callback(new Error("Unexpected hostname for validated DNS route"), "", 4);
        } else if (lookupOptions.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }
    } }) : void 0;
    const pinnedInit = {
      ...requestInit,
      redirect: "manual",
      __validated: { url: current.toString(), proxy: resolved.proxy, addresses },
      ...dispatcher ? { dispatcher } : {}
    };
    let response;
    try {
      response = await (options.fetch ? options.fetch(current, pinnedInit) : webFetch(current, pinnedInit, undiciFetch));
    } catch (error) {
      await dispatcher?.destroy();
      throw error;
    }
    if (dispatcher) void dispatcher.close().catch(() => {
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);
    const from = current;
    const next = new URL(location, current);
    await response.body?.cancel();
    resolved = await resolveRemoteUrl(next, next.origin === configuredOrigin ? validationOptions : { ...validationOptions, allowLoopback: false });
    if (response.status === 303 || (response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST") {
      const { body: _body, ...nextInit } = requestInit;
      requestInit = { ...nextInit, method: "GET" };
    }
    if (options.onRedirect) requestInit = options.onRedirect({ from, to: resolved.url, init: requestInit, response });
  }
  throw new Error(`Too many redirects fetching ${resolved.url.toString()}`);
}
function assertDomainPolicy(hostname, policy) {
  if (!policy) return;
  if (policy.deny.some((entry) => domainMatches(hostname, entry))) {
    throw new Error(`Blocked hostname by fetch_content domain policy: ${hostname}`);
  }
  if (policy.allow.length > 0 && !policy.allow.some((entry) => domainMatches(hostname, entry))) {
    throw new Error(`Hostname not allowed by fetch_content domain policy: ${hostname}`);
  }
}
function domainMatches(hostname, entry) {
  return hostname === entry || hostname.endsWith(`.${entry}`);
}
function assertPublicAddress(address, hostname, allowRanges = []) {
  const normalized = normalizeHostname(address);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
  if (isInAllowedRange(normalized, ipVersion, allowRanges)) return;
  if (ipVersion === 4 && isBlockedIPv4(normalized)) {
    const hint = isFakeIpProxyAddress(normalized) ? '. This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies. If that matches your setup, configure webAccess.ssrf.allowRanges with ["198.18.0.0/15"] in metis-pi.toml.' : "";
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}${hint}`);
  }
  if (ipVersion === 6 && isBlockedIPv6(normalized)) {
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
  }
}
function isFakeIpProxyAddress(address) {
  const [a, b] = address.split(".").map((part) => Number(part));
  return a === 198 && (b === 18 || b === 19);
}
function isBlockedIPv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || isFakeIpProxyAddress(address) || a >= 224;
}
function isBlockedIPv6(address) {
  const groups = parseIPv6(address);
  if (!groups) return true;
  const first = groups[0];
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((first & 65024) === 64512) return true;
  if ((first & 65472) === 65152) return true;
  const isMappedIPv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
  if (isMappedIPv4) {
    const ipv4 = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
    return isBlockedIPv4(ipv4);
  }
  return false;
}
function parseIPv6(address) {
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map((part) => Number(part));
    address = `${address.slice(0, lastColon)}:${(octets[0] << 8 | octets[1]).toString(16)}:${(octets[2] << 8 | octets[3]).toString(16)}`;
  }
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 && missing !== 0) return null;
  if (pieces.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
    return parseInt(part, 16);
  });
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 65535) ? groups : null;
}
function parseAllowRanges(input) {
  if (input === void 0 || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error("ssrf.allowRanges must be an array of CIDR strings");
  }
  const rules = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new Error(`ssrf.allowRanges entries must be strings, got ${typeof entry}`);
    }
    const rule = parseCidr(entry.trim());
    if (!rule) {
      throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
    }
    rules.push(rule);
  }
  return rules;
}
function parseCidr(raw) {
  if (!raw) return null;
  const slash = raw.lastIndexOf("/");
  const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
  if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
  const version = net.isIP(addrPart);
  if (version === 4) {
    const bytes = ipv4ToBytes(addrPart);
    if (!bytes) return null;
    const prefix = prefixPart === null ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
    return { bytes, prefix };
  }
  if (version === 6) {
    const groups = parseIPv6(addrPart);
    if (!groups) return null;
    const prefix = prefixPart === null ? 128 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
    return { bytes: ipv6GroupsToBytes(groups), prefix };
  }
  return null;
}
function ipv4ToBytes(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const octet = Number(parts[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}
function ipv6GroupsToBytes(groups) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 255;
  }
  return bytes;
}
function ipToBytes(address, version) {
  if (version === 4) return ipv4ToBytes(address);
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups ? ipv6GroupsToBytes(groups) : null;
  }
  return null;
}
function isInAllowedRange(address, ipVersion, allowRanges) {
  if (allowRanges.length === 0) return false;
  const addrBytes = ipToBytes(address, ipVersion);
  if (!addrBytes) return false;
  for (const rule of allowRanges) {
    if (rule.bytes.length !== addrBytes.length) continue;
    if (bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix)) return true;
  }
  return false;
}
function bytesMatchPrefix(addr, network, prefix) {
  const fullBytes = prefix >> 3;
  const remBits = prefix & 7;
  for (let i = 0; i < fullBytes; i++) {
    if (addr[i] !== network[i]) return false;
  }
  if (remBits > 0 && fullBytes < addr.length) {
    const mask = 255 << 8 - remBits & 255;
    if ((addr[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
  }
  return true;
}

// src/pi-web-access/firecrawl.ts
var CONFIG_PATH6 = webCredentialsPath();
var DEFAULT_API_VERSION = "v2";
var EXTRACT_TIMEOUT_MS = 6e4;
var SEARCH_TIMEOUT_MS5 = 6e4;
var SUPPORTED_API_VERSIONS = ["v1", "v2"];
var cachedConfig7 = null;
function loadConfig6() {
  return cachedConfig7 ??= loadWebAccessConfig();
}
function normalizeBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Firecrawl base URL in ${webPreferencesPath()}: expected an HTTP or HTTPS URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid Firecrawl base URL in ${webPreferencesPath()}: expected an HTTP or HTTPS URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid Firecrawl base URL in ${webPreferencesPath()}: URL credentials are not allowed`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}
function getBaseUrl() {
  return normalizeBaseUrl(process.env.FIRECRAWL_BASE_URL) ?? normalizeBaseUrl(loadConfig6().firecrawlBaseUrl);
}
function requireBaseUrl() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error(
      `Firecrawl base URL not configured. Either:
  1. Set firecrawlBaseUrl in ${webPreferencesPath()}
  2. Set FIRECRAWL_BASE_URL environment variable`
    );
  }
  return baseUrl;
}
function getApiVersion() {
  const environmentValue = typeof process.env.FIRECRAWL_API_VERSION === "string" ? process.env.FIRECRAWL_API_VERSION.trim() : "";
  const raw = environmentValue || loadConfig6().firecrawlApiVersion;
  if (raw === void 0 || raw === null) return DEFAULT_API_VERSION;
  if (typeof raw !== "string") {
    throw new Error(`firecrawlApiVersion in ${webPreferencesPath()} must be a string ("v1" or "v2")`);
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return DEFAULT_API_VERSION;
  if (!SUPPORTED_API_VERSIONS.includes(normalized)) {
    throw new Error(`Unsupported Firecrawl API version "${raw}". Supported versions: ${SUPPORTED_API_VERSIONS.join(", ")}`);
  }
  return normalized;
}
function allowFreshScrape() {
  const environmentValue = process.env.FIRECRAWL_FRESH_SCRAPE;
  if (environmentValue !== void 0) return environmentValue === "1" || environmentValue.toLowerCase() === "true";
  const configured = loadConfig6().firecrawlFreshScrape;
  if (configured === void 0 || configured === null) return false;
  if (typeof configured !== "boolean") throw new Error(`firecrawlFreshScrape in ${webPreferencesPath()} must be a boolean`);
  return configured;
}
function pdfParserOptions() {
  const configured = loadConfig6().firecrawlPdfMaxPages;
  if (configured === void 0 || configured === null) return {};
  if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 1) {
    throw new Error(`firecrawlPdfMaxPages in ${webPreferencesPath()} must be a positive integer`);
  }
  if (getApiVersion() === "v1") {
    throw new Error(
      `firecrawlPdfMaxPages in ${webPreferencesPath()} requires Firecrawl API v2; v1 has no PDF page cap. Use firecrawlApiVersion "v2" or remove firecrawlPdfMaxPages`
    );
  }
  return { parsers: [{ type: "pdf", maxPages: configured }] };
}
function withPdfTruncationNotice(content, metadata) {
  const parsed = metadata?.numPages;
  const total = metadata?.totalPages;
  if (typeof parsed !== "number" || typeof total !== "number" || parsed >= total) return content;
  return `${content}

---

*[Truncated: Only first ${parsed} of ${total} PDF pages parsed by Firecrawl]*`;
}
async function getApiKey5(signal) {
  const configKey = loadConfig6().firecrawlApiKey;
  return resolveCredential({
    provider: "Firecrawl",
    configuredValue: configKey,
    environmentValue: process.env.FIRECRAWL_API_KEY,
    signal
  });
}
function requestSignal6(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
function isAbortError(err) {
  return errorMessage(err).toLowerCase().includes("abort");
}
function ssrfOptions(options) {
  const config = loadSsrfConfig();
  return {
    allowRanges: options?.ssrf?.allowRanges ?? config.allowRanges,
    trustEnvProxy: options?.ssrf?.trustEnvProxy ?? config.trustEnvProxy,
    ...options?.lookup ? { lookup: options.lookup } : {}
  };
}
async function fetchFirecrawlApi(url, init, options) {
  const allowLoopback = isLoopbackHostname(new URL(url).hostname);
  return fetchRemoteUrl(url, init, {
    ...ssrfOptions(options),
    allowLoopback,
    fetch: options?.fetch,
    onRedirect: ({ from, to, init: next }) => {
      const headers = new Headers(next.headers);
      if (from.origin !== to.origin) {
        for (const name of ["Authorization", "Cookie", "X-API-Key"]) headers.delete(name);
      }
      return { ...next, method: init.method, body: init.body, headers };
    }
  });
}
function scrapeBody(url) {
  return {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    ...allowFreshScrape() ? {} : { lockdown: true },
    ...pdfParserOptions()
  };
}
function mapRecencyFilter2(value) {
  switch (value) {
    case "day":
      return "qdr:d";
    case "week":
      return "qdr:w";
    case "month":
      return "qdr:m";
    case "year":
      return "qdr:y";
    default:
      return void 0;
  }
}
function searchBody(query, options, numResults, filters) {
  const parserOptions = pdfParserOptions();
  const tbs = mapRecencyFilter2(options.recencyFilter);
  return {
    query,
    limit: numResults,
    sources: ["web"],
    ...filters.include.length > 0 ? { includeDomains: filters.include } : {},
    ...filters.include.length === 0 && filters.exclude.length > 0 ? { excludeDomains: filters.exclude } : {},
    ...tbs ? { tbs } : {},
    ...options.includeContent ? {
      scrapeOptions: {
        formats: ["markdown"],
        onlyMainContent: true,
        ...allowFreshScrape() ? {} : { lockdown: true },
        ...parserOptions
      }
    } : {}
  };
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
function mapSearchResults4(data, numResults, filters, includeContent) {
  const web = Array.isArray(data) ? data : data && typeof data === "object" ? data.web : void 0;
  if (!Array.isArray(web)) throw new Error("Firecrawl search returned an unexpected web result shape");
  const results = [];
  const inlineContent = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rawItem of web) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem;
    const url = firstString(item.url, item.metadata?.sourceURL, item.metadata?.url);
    if (!url || seen.has(url) || !matchesDomainFilter(url, filters)) continue;
    seen.add(url);
    const title = firstString(item.title, item.metadata?.title) ?? url;
    const snippet = firstString(item.description, item.snippet, item.metadata?.description) ?? "";
    results.push({ title, url, snippet });
    if (includeContent) {
      const markdown = firstString(item.markdown);
      if (markdown) inlineContent.push({ url, title, content: withPdfTruncationNotice(markdown, item.metadata), error: null });
    }
    if (results.length >= numResults) break;
  }
  return { results, inlineContent };
}
async function firecrawlFetch(endpoint, body, signal, options, label = endpoint, activity = void 0) {
  const baseUrl = requireBaseUrl();
  const version = getApiVersion();
  const apiKey = await getApiKey5(signal);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const requestUrl = `${baseUrl}/${version}/${endpoint}`;
  const activityId = activityMonitor.logStart(activity ?? { type: "fetch", url: requestUrl });
  try {
    const response = await fetchFirecrawlApi(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal6(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS, signal)
    }, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SearchHttpError(response.status, `Firecrawl ${label} error ${response.status}: ${redactCredential(text, apiKey).slice(0, 300)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(`Firecrawl ${label} returned invalid JSON`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Firecrawl ${label} returned an unexpected response shape`);
    }
    const envelope = data;
    if (envelope.success === false) {
      const reason = typeof envelope.error === "string" && envelope.error.trim() ? envelope.error : "unknown error";
      throw new Error(`Firecrawl ${label} unsuccessful: ${redactCredential(reason, apiKey)}`);
    }
    if (envelope.success !== true) {
      throw new Error(`Firecrawl ${label} returned an unexpected response shape`);
    }
    activityMonitor.logComplete(activityId, response.status);
    return envelope;
  } catch (err) {
    const message = errorMessage(err), redactedMessage = redactCredential(message, apiKey);
    if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
}
function isFirecrawlAvailable() {
  try {
    return getBaseUrl() !== null;
  } catch {
    return false;
  }
}
async function searchWithFirecrawl(query, options = {}) {
  requireBaseUrl();
  const numResults = normalizeSearchResultCount(options.numResults);
  const filters = normalizeDomainFilters(options.domainFilter);
  const envelope = await firecrawlFetch(
    "search",
    searchBody(query, options, numResults, filters),
    options.signal,
    { ...options, timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS5 },
    "search",
    { type: "api", query }
  );
  const mapped = mapSearchResults4(envelope.data, numResults, filters, options.includeContent);
  const response = { answer: formatSearchResultsAsAnswer(mapped.results), results: mapped.results };
  if (options.includeContent && mapped.inlineContent.length > 0) response.inlineContent = mapped.inlineContent;
  return response;
}
async function extractWithFirecrawl(url, signal, options) {
  requireBaseUrl();
  await validateRemoteUrl(url, ssrfOptions(options));
  const envelope = await firecrawlFetch("scrape", scrapeBody(url), signal, options);
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Firecrawl scrape returned an unexpected data shape");
  }
  const scrape = data;
  if (typeof scrape.markdown !== "string") {
    throw new Error("Firecrawl scrape returned markdown in an unexpected shape");
  }
  const content = scrape.markdown.trim();
  if (!content) return null;
  const metadataTitle = scrape.metadata?.title;
  const title = typeof metadataTitle === "string" && metadataTitle.trim() ? metadataTitle.trim() : typeof scrape.title === "string" ? scrape.title.trim() : "";
  return { url, title, content: withPdfTruncationNotice(content, scrape.metadata), error: null };
}

// src/pi-web-access/kagi.ts
var KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";
var KAGI_EXTRACT_URL = "https://kagi.com/api/v1/extract";
var CONFIG_PATH7 = webCredentialsPath();
var SEARCH_TIMEOUT_MS6 = 6e4;
var cachedConfig8 = null;
function loadConfig7() {
  return cachedConfig8 ??= loadWebAccessConfig();
}
async function getApiKey6(signal) {
  return resolveCredential({
    provider: "Kagi",
    configuredValue: loadConfig7().kagiApiKey,
    environmentValue: process.env.KAGI_API_KEY,
    signal
  });
}
async function requireApiKey(signal) {
  return requireProviderCredential(await getApiKey6(signal), {
    provider: "Kagi",
    configPath: CONFIG_PATH7,
    configKey: "kagiApiKey",
    envVar: "KAGI_API_KEY",
    keyInstructions: "Create a key at https://kagi.com/settings?p=api"
  });
}
function invalidResponse(message) {
  return new Error(`Kagi API returned invalid response: ${message}`);
}
function firstString2(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
function appendSearchItems(value, results, inlineContent) {
  if (Array.isArray(value)) {
    for (const item2 of value) appendSearchItems(item2, results, inlineContent);
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value;
  const url = firstString2(item.url, item.href, item.link);
  if (!url) return;
  const title = firstString2(item.title, item.name) ?? url;
  const snippet = firstString2(item.snippet, item.description, item.summary, item.content, item.markdown, item.text) ?? "";
  results.push({ title, url, snippet });
  if (inlineContent) {
    const content = firstString2(item.markdown, item.content, item.text);
    if (content) inlineContent.push({ url, title, content, error: null });
  }
}
function parseErrors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value;
  const rawErrors = envelope.errors ?? envelope.error;
  if (!Array.isArray(rawErrors)) return null;
  const messages = rawErrors.map((entry) => {
    if (!entry || typeof entry !== "object") return String(entry);
    const raw = entry;
    return firstString2(raw.message, raw.msg, raw.code) ?? JSON.stringify(raw);
  });
  return messages.length > 0 ? messages.join("; ") : null;
}
function parseSearchResponse(value, includeContent) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
  const message = parseErrors(value);
  if (message) throw invalidResponse(message);
  const envelope = value;
  const results = [];
  const inlineContent = [];
  const data = envelope.data;
  const items = typeof data === "object" && data !== null && !Array.isArray(data) ? data.search : data;
  appendSearchItems(items, results, includeContent ? inlineContent : void 0);
  return { results, inlineContent };
}
function parseExtractResponse(value, requestedUrl) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected extract object envelope");
  const message = parseErrors(value);
  if (message) throw invalidResponse(message);
  const envelope = value;
  const candidates = Array.isArray(envelope.data) ? envelope.data : [envelope.data ?? envelope];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate;
    const content = firstString2(item.markdown, item.content, item.text);
    if (!content) continue;
    return {
      url: firstString2(item.url, item.href, item.link) ?? requestedUrl,
      title: firstString2(item.title, item.name) ?? requestedUrl,
      content,
      error: null
    };
  }
  return null;
}
function isKagiAvailable() {
  return hasCredentialSource({ provider: "Kagi", configuredValue: loadConfig7().kagiApiKey, environmentValue: process.env.KAGI_API_KEY });
}
async function searchWithKagi(query, options = {}) {
  const apiKey = await requireApiKey(options.signal);
  const numResults = normalizeSearchResultCount(options.numResults);
  const domains = normalizeDomainFilters(options.domainFilter);
  const hasDomains = domains.include.length > 0 || domains.exclude.length > 0;
  const days = options.recencyFilter ? { day: 1, week: 7, month: 30, year: 365 }[options.recencyFilter] : void 0;
  const after = days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : void 0;
  const activityId = activityMonitor.logStart({ type: "api", query });
  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS6);
  try {
    const response = await webFetch(KAGI_SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query,
        limit: hasDomains ? 20 : numResults,
        ...after ? { filters: { after } } : {},
        ...hasDomains ? { lens: {
          ...domains.include.length ? { sites_included: domains.include } : {},
          ...domains.exclude.length ? { sites_excluded: domains.exclude } : {}
        } } : {}
      }),
      signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal
    });
    if (!response.ok) {
      const errorText = redactCredential(await response.text(), apiKey);
      throw new SearchHttpError(response.status, `Kagi API error ${response.status}: ${errorText.slice(0, 300)}`);
    }
    let rawData;
    try {
      rawData = await response.json();
    } catch (err) {
      if (options.signal?.aborted || err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
      throw new Error("Kagi API returned invalid JSON");
    }
    const parsed = parseSearchResponse(rawData, options.includeContent);
    const results = parsed.results.filter((result) => matchesDomainFilter(result.url, domains)).slice(0, numResults);
    const mapped = { answer: formatSearchResultsAsAnswer(results), results };
    if (options.includeContent) {
      const urls = new Set(results.map((result) => result.url));
      const inlineContent = parsed.inlineContent.filter((content) => urls.has(content.url));
      if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
    }
    activityMonitor.logComplete(activityId, response.status);
    return mapped;
  } catch (err) {
    if (options.signal?.aborted || err instanceof Error && err.name === "AbortError" && !timeoutSignal.aborted) {
      activityMonitor.logComplete(activityId, 0);
      throw new Error("Aborted");
    }
    const message = errorMessage(err);
    const safeMessage = timeoutSignal.aborted || err instanceof Error && err.name === "TimeoutError" ? "Kagi request timed out after 60s" : redactCredential(message, apiKey);
    const outgoing = safeMessage === message && err instanceof Error ? err : err instanceof SearchHttpError ? new SearchHttpError(err.status, safeMessage) : err instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
    if (outgoing instanceof SearchHttpError) activityMonitor.logComplete(activityId, outgoing.status);
    else activityMonitor.logError(activityId, safeMessage);
    throw outgoing;
  }
}
function isKagiExtractAvailable() {
  return isKagiAvailable();
}
async function extractWithKagi(url, signal, options = {}) {
  const ssrf = options.ssrf ?? loadSsrfConfig();
  const domainPolicy = loadFetchContentDomainPolicy();
  await validateRemoteUrl(url, {
    allowRanges: ssrf.allowRanges,
    trustEnvProxy: ssrf.trustEnvProxy,
    domainPolicy,
    ...options.lookup ? { lookup: options.lookup } : {}
  });
  const apiKey = await requireApiKey(signal);
  const activityId = activityMonitor.logStart({ type: "api", query: `kagi extract: ${url}` });
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS6);
  try {
    const response = await fetchRemoteUrl(KAGI_EXTRACT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ pages: [{ url }] }),
      signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    }, {
      fetch: options.fetch,
      allowRanges: ssrf.allowRanges,
      trustEnvProxy: ssrf.trustEnvProxy,
      onRedirect: ({ from, to, init }) => to.origin === from.origin ? init : { ...init, headers: { "Content-Type": "application/json", Accept: "application/json" } },
      ...options.lookup ? { lookup: options.lookup } : {}
    });
    if (!response.ok) {
      const errorText = redactCredential(await response.text(), apiKey);
      throw new SearchHttpError(response.status, `Kagi Extract API error ${response.status}: ${errorText.slice(0, 300)}`);
    }
    let rawData;
    try {
      rawData = await response.json();
    } catch (err) {
      if (signal?.aborted || err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
      throw new Error("Kagi Extract API returned invalid JSON");
    }
    const parsed = parseExtractResponse(rawData, url);
    activityMonitor.logComplete(activityId, response.status);
    return parsed;
  } catch (err) {
    if (signal?.aborted || err instanceof Error && err.name === "AbortError" && !timeoutSignal.aborted) {
      activityMonitor.logComplete(activityId, 0);
      throw new Error("Aborted");
    }
    const message = errorMessage(err);
    const safeMessage = timeoutSignal.aborted || err instanceof Error && err.name === "TimeoutError" ? "Kagi extract request timed out" : redactCredential(message, apiKey);
    const outgoing = safeMessage === message && err instanceof Error ? err : err instanceof SearchHttpError ? new SearchHttpError(err.status, safeMessage) : err instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
    if (outgoing instanceof SearchHttpError) activityMonitor.logComplete(activityId, outgoing.status);
    else activityMonitor.logError(activityId, safeMessage);
    throw outgoing;
  }
}

// src/pi-web-access/ollama.ts
var OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
var OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";
var CONFIG_PATH8 = webCredentialsPath();
var SEARCH_TIMEOUT_MS7 = 6e4;
var cachedConfig9 = null;
function loadConfig8() {
  return cachedConfig9 ??= loadWebAccessConfig();
}
async function getApiKey7(signal) {
  return resolveCredential({
    provider: "Ollama",
    configuredValue: loadConfig8().ollamaApiKey,
    environmentValue: process.env.OLLAMA_API_KEY,
    signal
  });
}
async function requireApiKey2(signal) {
  return requireProviderCredential(await getApiKey7(signal), {
    provider: "Ollama",
    configPath: CONFIG_PATH8,
    configKey: "ollamaApiKey",
    envVar: "OLLAMA_API_KEY",
    keyInstructions: "Create a key at https://ollama.com/settings/keys"
  });
}
function invalidResponse2(message) {
  return new Error(`Ollama API returned invalid response: ${message}`);
}
function parseSearchResponse2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse2("expected an object envelope");
  const envelope = value;
  if (!Array.isArray(envelope.results)) throw invalidResponse2("expected results array");
  const results = [];
  for (const [index, value2] of envelope.results.entries()) {
    if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) throw invalidResponse2(`expected results[${index}] object`);
    const item = value2;
    if (typeof item.title !== "string") throw invalidResponse2(`expected results[${index}].title string`);
    if (typeof item.url !== "string" || !item.url) throw invalidResponse2(`expected results[${index}].url non-empty string`);
    if (typeof item.content !== "string") throw invalidResponse2(`expected results[${index}].content string`);
    results.push({ title: item.title, url: item.url, content: item.content });
  }
  return { results };
}
function parseFetchResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse2("expected fetch object envelope");
  const envelope = value;
  if (typeof envelope.title !== "string") throw invalidResponse2("expected title string");
  if (typeof envelope.content !== "string") throw invalidResponse2("expected content string");
  return { title: envelope.title, content: envelope.content };
}
function isOllamaAvailable() {
  return hasCredentialSource({ provider: "Ollama", configuredValue: loadConfig8().ollamaApiKey, environmentValue: process.env.OLLAMA_API_KEY });
}
async function searchWithOllama(query, options = {}) {
  if (options.recencyFilter) throw new SearchUnsupportedFilterError("Ollama web search does not support recencyFilter");
  const apiKey = await requireApiKey2(options.signal);
  const numResults = normalizeSearchResultCount(options.numResults, { max: 10 });
  const filters = normalizeDomainFilters(options.domainFilter);
  const hasDomains = filters.include.length > 0 || filters.exclude.length > 0;
  const activityId = activityMonitor.logStart({ type: "api", query });
  let response;
  try {
    response = await webFetch(OLLAMA_SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: hasDomains ? 10 : numResults }),
      signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS7), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS7)
    });
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
  if (!response.ok) {
    activityMonitor.logComplete(activityId, response.status);
    const errorText = redactCredential(await response.text(), apiKey);
    throw new SearchHttpError(response.status, `Ollama API error ${response.status}: ${errorText.slice(0, 300)}`);
  }
  let rawData;
  try {
    rawData = await response.json();
  } catch (err) {
    activityMonitor.logComplete(activityId, response.status);
    throw new Error(`Ollama API returned invalid JSON: ${errorMessage(err)}`);
  }
  let data;
  try {
    data = parseSearchResponse2(rawData);
  } catch (err) {
    activityMonitor.logError(activityId, errorMessage(err));
    throw err;
  }
  activityMonitor.logComplete(activityId, response.status);
  const retained = data.results.filter((result) => matchesDomainFilter(result.url, filters)).slice(0, numResults);
  const results = retained.map((result) => ({ title: result.title, url: result.url, snippet: result.content }));
  const mapped = { answer: formatSearchResultsAsAnswer(results), results };
  if (options.includeContent) {
    const inlineContent = retained.filter((result) => result.content.trim().length > 0).map((result) => ({ url: result.url, title: result.title, content: result.content, error: null }));
    if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
  }
  return mapped;
}
function isOllamaFetchAvailable() {
  return isOllamaAvailable();
}
async function extractWithOllama(url, signal, options = {}) {
  const ssrf = options.ssrf ?? loadSsrfConfig();
  const domainPolicy = loadFetchContentDomainPolicy();
  await validateRemoteUrl(url, {
    allowRanges: ssrf.allowRanges,
    trustEnvProxy: ssrf.trustEnvProxy,
    domainPolicy,
    ...options.lookup ? { lookup: options.lookup } : {}
  });
  const apiKey = await requireApiKey2(signal);
  const activityId = activityMonitor.logStart({ type: "api", query: `ollama fetch: ${url}` });
  let response;
  try {
    response = await fetchRemoteUrl(OLLAMA_FETCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS7), signal]) : AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS7)
    }, {
      fetch: options.fetch,
      allowRanges: ssrf.allowRanges,
      trustEnvProxy: ssrf.trustEnvProxy,
      onRedirect: ({ from, to, init }) => to.origin === from.origin ? init : { ...init, headers: { "Content-Type": "application/json" } },
      ...options.lookup ? { lookup: options.lookup } : {}
    });
  } catch (err) {
    const message = errorMessage(err);
    const redactedMessage = redactCredential(message, apiKey);
    if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = new Error(redactedMessage);
    if (err instanceof Error) redactedError.name = err.name;
    throw redactedError;
  }
  if (!response.ok) {
    activityMonitor.logComplete(activityId, response.status);
    const errorText = redactCredential(await response.text(), apiKey);
    throw new Error(`Ollama Web Fetch error ${response.status}: ${errorText.slice(0, 300)}`);
  }
  let rawData;
  try {
    rawData = await response.json();
  } catch (err) {
    activityMonitor.logComplete(activityId, response.status);
    throw new Error(`Ollama Web Fetch returned invalid JSON: ${errorMessage(err)}`);
  }
  let data;
  try {
    data = parseFetchResponse(rawData);
  } catch (err) {
    activityMonitor.logError(activityId, errorMessage(err));
    throw err;
  }
  activityMonitor.logComplete(activityId, response.status);
  const content = data.content.trim();
  if (!content) return null;
  return { url, title: data.title, content, error: null };
}

// src/pi-web-access/auth-fetch.ts
var WEB_PREFERENCES_PATH2 = webPreferencesPath();
var AUTH_PROFILE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function resolveAuthFetchProfile(request) {
  const profiles = loadAuthFetchProfiles();
  if (profiles.length === 0) {
    throw new Error(`auth requires at least one authFetch profile in ${WEB_PREFERENCES_PATH2}`);
  }
  if (request === true) {
    if (profiles.length !== 1) {
      throw new Error("auth: true requires exactly one authFetch profile; use a profile name instead");
    }
    return profiles[0];
  }
  const name = request.trim();
  const profile = profiles.find((candidate) => candidate.name === name);
  if (!profile) throw new Error(`Unknown authFetch profile: ${name}`);
  return profile;
}
function assertAuthFetchUrl(profile, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Authenticated fetch requires an HTTPS URL: ${message}`);
  }
  if (url.protocol !== "https:") throw new Error("Authenticated fetch requires an HTTPS URL");
  const hostname = normalizeHostname(url.hostname);
  if (!profile.hosts.some((host) => hostMatches(hostname, host))) {
    throw new Error(`URL host ${hostname} is not allowed by authFetch profile ${profile.name}`);
  }
  return url;
}
function authFetchRedirectGuard(profile, from, to) {
  if (profile.redirects === "same-origin" && to.origin !== from.origin) {
    throw new Error(`Authenticated fetch refused cross-origin redirect: ${from.origin} -> ${to.origin}`);
  }
}
function loadAuthFetchProfiles() {
  const parsed = loadWebAccessConfig();
  if (parsed.authFetch === void 0 || parsed.authFetch === null) return [];
  if (typeof parsed.authFetch !== "object" || Array.isArray(parsed.authFetch)) {
    throw new Error(`authFetch in ${WEB_PREFERENCES_PATH2} must be an object`);
  }
  return Object.entries(parsed.authFetch).map(([name, value]) => parseProfile(name, value));
}
function parseProfile(name, value) {
  if (!AUTH_PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`authFetch profile name ${JSON.stringify(name)} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
  }
  if (Array.isArray(value)) {
    return { name, hosts: parseHosts(value, `authFetch.${name}`), redirects: "same-origin", cache: "session" };
  }
  if (!value || typeof value !== "object") {
    throw new Error(`authFetch.${name} in ${WEB_PREFERENCES_PATH2} must be an array of hosts or an object`);
  }
  const config = value;
  if (!Array.isArray(config.hosts)) {
    throw new Error(`authFetch.${name}.hosts in ${WEB_PREFERENCES_PATH2} must be a non-empty array of hostnames`);
  }
  const redirects = config.redirects ?? "same-origin";
  if (redirects !== "same-origin") {
    throw new Error(`authFetch.${name}.redirects in ${WEB_PREFERENCES_PATH2} must be "same-origin"`);
  }
  const cache = config.cache ?? "session";
  if (cache !== "session" && cache !== "off") {
    throw new Error(`authFetch.${name}.cache in ${WEB_PREFERENCES_PATH2} must be "session" or "off"`);
  }
  const chromeProfile = parseChromeProfile(config.chromeProfile, `authFetch.${name}.chromeProfile`);
  return {
    name,
    hosts: parseHosts(config.hosts, `authFetch.${name}.hosts`),
    ...chromeProfile ? { chromeProfile } : {},
    redirects,
    cache
  };
}
function parseHosts(value, label) {
  if (value.length === 0) throw new Error(`${label} in ${WEB_PREFERENCES_PATH2} must be a non-empty array of hostnames`);
  const hosts = value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} in ${WEB_PREFERENCES_PATH2} must contain only hostnames`);
    return parseHost(entry, label);
  });
  return [...new Set(hosts)];
}
function parseHost(value, label) {
  const host = normalizeHostname(value.trim());
  if (!host || host.startsWith(".") || host.endsWith(".") || /\s|[\\/?:#@*]/.test(host)) {
    throw new Error(`${label} in ${WEB_PREFERENCES_PATH2} contains an invalid hostname: ${JSON.stringify(value)}`);
  }
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
    throw new Error(`${label} in ${WEB_PREFERENCES_PATH2} contains an invalid hostname: ${JSON.stringify(value)}`);
  }
  return host;
}
function parseChromeProfile(value, label) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new Error(`${label} in ${WEB_PREFERENCES_PATH2} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`${label} in ${WEB_PREFERENCES_PATH2} must be a profile directory name, not a path`);
  }
  return normalized;
}
function hostMatches(hostname, allowedHost) {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}

// src/pi-web-access/media-errors.ts
function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function readExecError(err) {
  if (!err || typeof err !== "object") {
    return { stderr: "", message: String(err) };
  }
  const code = err.code;
  const message = err.message ?? "";
  const stderrRaw = err.stderr;
  const stderr = Buffer.isBuffer(stderrRaw) ? stderrRaw.toString("utf-8") : typeof stderrRaw === "string" ? stderrRaw : "";
  return { code, stderr, message };
}
function isTimeoutError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.killed) return true;
  const name = err.name;
  const code = err.code;
  const message = err.message ?? "";
  return name === "AbortError" || code === "ETIMEDOUT" || message.toLowerCase().includes("timed out");
}
function trimErrorText(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
function mapFfmpegError(err) {
  const { code, stderr, message } = readExecError(err);
  if (code === "ENOENT") return "ffmpeg is not installed. Install with: brew install ffmpeg";
  if (isTimeoutError(err)) return "ffmpeg timed out extracting frame";
  if (stderr.includes("403")) return "Stream URL returned 403 \u2014 may have expired, try again";
  const snippet = trimErrorText(stderr || message);
  return snippet ? `ffmpeg failed: ${snippet}` : "ffmpeg failed";
}

// src/pi-web-access/gemini-adc.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { createSign } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
var DEFAULT_ADC_PATH = join4(homedir2(), ".config", "gcloud", "application_default_credentials.json");
var TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
var VERTEX_HOST = "https://aiplatform.googleapis.com";
var VERTEX_API_VERSION = "v1";
var REFRESH_SKEW_MS = 6e4;
var cachedConfig10 = null;
function loadConfig9() {
  return cachedConfig10 ??= loadWebAccessConfig();
}
function normalizeIdentifier(value, envName) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  const fromEnv = process.env[envName]?.trim();
  return fromEnv ? fromEnv : null;
}
function isAdcAuthSelected() {
  return (loadConfig9().geminiAuth ?? "").toString().trim().toLowerCase() === "adc";
}
function getAdcProject() {
  return normalizeIdentifier(loadConfig9().geminiProject, "GOOGLE_CLOUD_PROJECT") ?? normalizeIdentifier(null, "GCLOUD_PROJECT");
}
function getAdcLocation() {
  return normalizeIdentifier(loadConfig9().geminiLocation, "GOOGLE_CLOUD_LOCATION");
}
function getAdcPath() {
  return process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || DEFAULT_ADC_PATH;
}
function getVertexApiBase(project, location) {
  return `${VERTEX_HOST}/${VERTEX_API_VERSION}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google`;
}
function isVertexHost(origin) {
  return origin === VERTEX_HOST;
}
function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringField(record, name) {
  const value = record[name];
  return typeof value === "string" ? value : void 0;
}
function requiredString(record, name, context) {
  const value = stringField(record, name)?.trim();
  if (!value) throw new Error(`${context} is missing ${name}`);
  return value;
}
function parseAdcFile(raw) {
  const parsed = objectRecord(JSON.parse(raw));
  if (!parsed) throw new Error("credential root must be an object");
  const type = stringField(parsed, "type") ?? "authorized_user";
  if (type === "authorized_user") {
    return {
      type,
      client_id: requiredString(parsed, "client_id", "Gemini ADC authorized_user file"),
      client_secret: requiredString(parsed, "client_secret", "Gemini ADC authorized_user file"),
      refresh_token: requiredString(parsed, "refresh_token", "Gemini ADC authorized_user file")
    };
  }
  if (type === "service_account") {
    return {
      type,
      client_email: requiredString(parsed, "client_email", "Gemini ADC service_account file"),
      private_key: requiredString(parsed, "private_key", "Gemini ADC service_account file"),
      token_uri: stringField(parsed, "token_uri")
    };
  }
  return { type };
}
function parseTokenExchangeResponse(text, context) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${context} returned invalid JSON: ${message}`);
  }
  const parsed = objectRecord(raw);
  if (!parsed) throw new Error(`${context} returned a non-object response`);
  const token = stringField(parsed, "access_token")?.trim();
  if (!token) throw new Error(`${context} returned no access_token`);
  const expiresIn = parsed.expires_in ?? 3600;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new Error(`${context} returned invalid expires_in`);
  }
  return { token, expiresAt: Date.now() + Math.max(expiresIn * 1e3 - REFRESH_SKEW_MS, 6e4) };
}
async function loadAdcFile() {
  const path = getAdcPath();
  if (!path || !existsSync3(path)) {
    throw new Error(`Google Application Default Credentials file not found at ${path}`);
  }
  const raw = readFileSync3(path, "utf-8");
  try {
    return parseAdcFile(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Google Application Default Credentials file at ${path}: ${message}`);
  }
}
var cachedToken = null;
var OAUTH_CREDENTIAL_REJECTION_STATUSES = /* @__PURE__ */ new Set([400, 401, 403]);
function throwOnTokenExchangeFailure(detail, status) {
  if (OAUTH_CREDENTIAL_REJECTION_STATUSES.has(status)) {
    throw new CredentialResolutionError("Gemini ADC", "oauth-credential-rejected");
  }
  throw new Error(`Gemini ADC token exchange failed (${status}): ${detail.slice(0, 300)}`);
}
async function exchangeRefreshToken(cfg, signal) {
  const body = new URLSearchParams({
    client_id: cfg.client_id ?? "",
    client_secret: cfg.client_secret ?? "",
    refresh_token: cfg.refresh_token ?? "",
    grant_type: "refresh_token"
  });
  const res = await webFetch(TOKEN_ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal
  });
  const text = await res.text();
  if (!res.ok) {
    throwOnTokenExchangeFailure(text, res.status);
  }
  return parseTokenExchangeResponse(text, "Gemini ADC token exchange");
}
async function exchangeServiceAccountJwt(cfg, signal) {
  if (!cfg.client_email || !cfg.private_key) {
    throw new Error("Gemini ADC service_account file is missing client_email or private_key");
  }
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: cfg.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600
  };
  const encodePart = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const assertion = `${encodePart(header)}.${encodePart(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(assertion);
  signer.end();
  const signature = signer.sign(cfg.private_key, "base64url");
  const jwt = `${assertion}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });
  const res = await webFetch(cfg.token_uri || TOKEN_ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal
  });
  const text = await res.text();
  if (!res.ok) {
    throwOnTokenExchangeFailure(text, res.status);
  }
  return parseTokenExchangeResponse(text, "Gemini ADC service account token exchange");
}
async function getAdcAccessToken(signal) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  const cfg = await loadAdcFile();
  const type = cfg.type ?? "authorized_user";
  if (type === "authorized_user") {
    cachedToken = await exchangeRefreshToken(cfg, signal);
  } else if (type === "service_account") {
    cachedToken = await exchangeServiceAccountJwt(cfg, signal);
  } else {
    throw new Error(`Gemini ADC unsupported credential type "${type}" (expected authorized_user or service_account)`);
  }
  return cachedToken.token;
}
function isGeminiAdcAvailable() {
  if (!isAdcAuthSelected()) return false;
  if (hasGeminiApiKeySource()) return false;
  if (hasExplicitApiBase()) return false;
  if (!getAdcProject() || !getAdcLocation()) return false;
  return existsSync3(getAdcPath());
}
function hasGeminiApiKeySource() {
  const configured = loadConfig9().geminiApiKey;
  if (typeof configured === "string" && configured.trim()) return true;
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  return !!fromEnv;
}
function hasExplicitApiBase() {
  const fromEnv = process.env.GOOGLE_GEMINI_BASE_URL?.trim();
  if (fromEnv) return true;
  const configured = loadConfig9().geminiBaseUrl;
  return typeof configured === "string" && configured.trim().length > 0;
}

// src/pi-web-access/gemini-api.ts
var DEFAULT_API_HOST = "https://generativelanguage.googleapis.com";
var API_VERSION = "v1beta";
var API_BASE = `${DEFAULT_API_HOST}/${API_VERSION}`;
var CONFIG_PATH9 = webCredentialsPath();
var DEFAULT_MODEL = "gemini-3.6-flash";
var cachedConfig11 = null;
function loadConfig10() {
  return cachedConfig11 ??= loadWebAccessConfig();
}
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function normalizeApiKey2(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
function normalizeBaseUrl2(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}
function isCloudflareGateway() {
  return getApiHost().includes("gateway.ai.cloudflare.com");
}
async function getApiKey8(signal) {
  return resolveCredential({
    provider: "Gemini",
    configuredValue: loadConfig10().geminiApiKey,
    environmentValue: process.env.GEMINI_API_KEY,
    signal
  });
}
function getApiHost() {
  return normalizeBaseUrl2(process.env.GOOGLE_GEMINI_BASE_URL) ?? normalizeBaseUrl2(loadConfig10().geminiBaseUrl) ?? DEFAULT_API_HOST;
}
function getVersionedApiBase() {
  const project = getAdcProject();
  const location = getAdcLocation();
  if (isGeminiAdcAvailable() && project && location) {
    return getVertexApiBase(project, location);
  }
  return `${getApiHost()}/${API_VERSION}`;
}
function getUploadBase() {
  return `${getApiHost()}/upload/${API_VERSION}`;
}
function getLegacyCloudflareApiKey() {
  return normalizeApiKey2(process.env.CLOUDFLARE_API_KEY) ?? normalizeApiKey2(loadConfig10().cloudflareApiKey);
}
async function resolveCloudflareApiKey(signal) {
  return resolveCredential({
    provider: "Cloudflare",
    configuredValue: loadConfig10().cloudflareApiKey,
    environmentValue: process.env.CLOUDFLARE_API_KEY,
    signal
  });
}
function isGatewayConfigured() {
  return isCloudflareGateway() && hasCredentialSource({
    provider: "Cloudflare",
    configuredValue: loadConfig10().cloudflareApiKey,
    environmentValue: process.env.CLOUDFLARE_API_KEY
  });
}
function buildAuthHeaders(apiKey = null, cloudflareApiKey = getLegacyCloudflareApiKey()) {
  if (!isCloudflareGateway()) return apiKey ? { "x-goog-api-key": apiKey } : {};
  return cloudflareApiKey ? { "cf-aig-authorization": `Bearer ${cloudflareApiKey}` } : {};
}
function redactGeminiCredentials(text, apiKey, cloudflareApiKey, adcToken) {
  let out = redactCredential(redactCredential(text, apiKey), cloudflareApiKey);
  if (adcToken) out = redactCredential(out, adcToken);
  return out;
}
var responseCredentials = /* @__PURE__ */ new WeakMap();
function redactGeminiApiResponse(response, text, apiKey, adcToken) {
  const credentials = responseCredentials.get(response);
  return redactGeminiCredentials(text, credentials?.apiKey ?? apiKey, credentials?.cloudflareApiKey, credentials?.adcToken ?? adcToken);
}
async function fetchGeminiApi(url, init = {}, apiKey) {
  const parsedUrl = new URL(url);
  for (const name of parsedUrl.searchParams.keys()) {
    if (["key", "api_key"].includes(name.toLowerCase())) {
      throw new Error("Gemini API credential query parameters are not allowed");
    }
  }
  const project = getAdcProject();
  const location = getAdcLocation();
  const adcMode = isGeminiAdcAvailable() && !!project && !!location && isVertexHost(parsedUrl.origin);
  let adcToken = null;
  if (adcMode) {
    adcToken = await getAdcAccessToken(init.signal ?? void 0);
  }
  const resolvedApiKey = adcMode ? null : apiKey === void 0 ? await getApiKey8(init.signal ?? void 0) : apiKey;
  const cloudflareApiKey = isCloudflareGateway() ? await resolveCloudflareApiKey(init.signal ?? void 0) : null;
  const allowedOrigins = /* @__PURE__ */ new Set([
    new URL(getApiHost()).origin,
    new URL(DEFAULT_API_HOST).origin,
    ...adcMode ? [parsedUrl.origin] : []
  ]);
  const needsAuth = resolvedApiKey || isGatewayConfigured() || adcMode;
  if (needsAuth && !allowedOrigins.has(parsedUrl.origin)) {
    throw new Error("Gemini API request host is not allowed");
  }
  const headers = new Headers(init.headers);
  headers.delete("x-goog-api-key");
  headers.delete("cf-aig-authorization");
  headers.delete("authorization");
  if (adcMode && adcToken) {
    headers.set("Authorization", `Bearer ${adcToken}`);
  } else {
    for (const [name, value] of Object.entries(buildAuthHeaders(resolvedApiKey, cloudflareApiKey))) {
      headers.set(name, value);
    }
  }
  try {
    const response = await fetchWithCredentialRedirects(parsedUrl.toString(), { ...init, headers }, ["x-goog-api-key", "cf-aig-authorization", "Authorization"]);
    responseCredentials.set(response, { apiKey: resolvedApiKey, cloudflareApiKey, adcToken });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redactedMessage = redactGeminiCredentials(message, resolvedApiKey, cloudflareApiKey, adcToken);
    if (redactedMessage === message) throw error;
    const redactedError = new Error(redactedMessage);
    if (error instanceof Error) redactedError.name = error.name;
    throw redactedError;
  }
}
function hasGeminiApiKeySource2() {
  return hasCredentialSource({
    provider: "Gemini",
    configuredValue: loadConfig10().geminiApiKey,
    environmentValue: process.env.GEMINI_API_KEY
  });
}
function isGeminiApiAvailable() {
  return isGeminiAdcAvailable() || hasGeminiApiKeySource2() || isGatewayConfigured();
}
function isGeminiApiAvailableWithVideo() {
  return hasGeminiApiKeySource2() || isGatewayConfigured();
}
async function queryGeminiApiWithInlineData(prompt, data, mimeType, options = {}) {
  const signal = withTimeout(options.signal, options.timeoutMs ?? 12e4);
  const apiKey = isGeminiAdcAvailable() ? null : options.apiKey ?? await getApiKey8(signal);
  if (!apiKey && !isGatewayConfigured() && !isGeminiAdcAvailable()) {
    throw new Error(
      `Gemini API not configured. Either:
  1. Configure geminiApiKey in ${CONFIG_PATH9} or set GEMINI_API_KEY
  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing
  3. Set geminiAuth to "adc" with a Google Cloud ADC (GOOGLE_APPLICATION_CREDENTIALS) + project/location`
    );
  }
  const model = options.model ?? DEFAULT_MODEL;
  const url = `${getVersionedApiBase()}/models/${model}:generateContent`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data } },
          { text: prompt }
        ]
      }
    ]
  };
  const res = await fetchGeminiApi(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  }, apiKey);
  if (!res.ok) {
    const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
    throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
  }
  const response = await res.json();
  const candidate = response.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text).filter((part) => typeof part === "string" && part.length > 0).join("\n") ?? "";
  return {
    text,
    ...candidate?.finishReason ? { finishReason: candidate.finishReason } : {},
    ...response.promptFeedback?.blockReason ? { blockReason: response.promptFeedback.blockReason } : {}
  };
}
async function queryGeminiApiWithVideo(prompt, videoUri, options = {}) {
  const signal = withTimeout(options.signal, options.timeoutMs ?? 12e4);
  const apiKey = options.apiKey ?? await getApiKey8(signal);
  if (!apiKey && !isGatewayConfigured()) {
    throw new Error(
      `Gemini API not configured. Either:
  1. Configure geminiApiKey in ${CONFIG_PATH9} or set GEMINI_API_KEY
  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing`
    );
  }
  const model = options.model ?? DEFAULT_MODEL;
  const url = `${getVersionedApiBase()}/models/${model}:generateContent`;
  const fileData = { fileUri: videoUri };
  if (options.mimeType) fileData.mimeType = options.mimeType;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { fileData },
          { text: prompt }
        ]
      }
    ]
  };
  const res = await fetchGeminiApi(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  }, apiKey);
  if (!res.ok) {
    const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
    throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n");
  if (!text) throw new Error("Gemini API returned empty response");
  return text;
}

// src/pi-web-access/gemini-web.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { basename as basename2 } from "node:path";
var GEMINI_APP_URL = "https://gemini.google.com/app";
var GEMINI_STREAM_GENERATE_URL = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
var GEMINI_UPLOAD_URL = "https://content-push.googleapis.com/upload";
var GEMINI_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
var GOOGLE_LIST_ACCOUNTS_URL = "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&laf=b64bin&json=standard";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";
var DEFAULT_GEMINI_WEB_MODEL = "gemini-3.1-pro";
var MODEL_HEADERS = {
  [DEFAULT_GEMINI_WEB_MODEL]: '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]',
  "gemini-2.5-pro": '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]',
  "gemini-2.5-flash": '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]'
};
var REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];
var geminiFetchImpl = null;
var geminiFetchOverride = null;
var GEMINI_MAX_HEADER_SIZE = 4 * 1024 * 1024;
function createGeminiFetch(undiciImpl) {
  const agent = new undiciImpl.EnvHttpProxyAgent({
    allowH2: false,
    connectTimeout: 3e4,
    maxHeaderSize: GEMINI_MAX_HEADER_SIZE,
    pipelining: 1
  });
  return (input, init) => webFetch(input, { ...init, dispatcher: agent }, undiciImpl.fetch);
}
async function resolveGeminiFetch() {
  if (geminiFetchOverride) return geminiFetchOverride;
  return geminiFetchImpl ??= (async () => {
    let undici;
    try {
      undici = await import("undici");
    } catch {
      return webFetch;
    }
    return createGeminiFetch(undici);
  })().catch((error) => {
    geminiFetchImpl = null;
    throw error;
  });
}
async function getGeminiWebAvailability(chromeProfile) {
  if (!isBrowserCookieAccessAllowed()) return void 0;
  const configured = getBrowserCookieSelectionFromConfig();
  return getGoogleCookies({
    browser: configured.browser,
    profile: normalizeChromeProfile(chromeProfile) ?? configured.profile,
    requiredCookies: REQUIRED_COOKIES
  });
}
async function isGeminiWebAvailable(chromeProfile) {
  const outcome = await getGeminiWebAvailability(chromeProfile);
  return outcome?.ok ? outcome.cookies : null;
}
function getGeminiWebAvailabilityDiagnostic(outcome) {
  return outcome?.ok === false ? outcome.diagnostic.message : null;
}
function getGeminiWebAvailabilityDiagnosticDetails(outcome) {
  return outcome?.ok === false ? outcome.diagnostic : null;
}
async function getActiveGoogleEmail(cookies) {
  const cookieHeader = buildCookieHeader2(cookies);
  if (!cookieHeader) return null;
  try {
    const html = await fetchWithCookieRedirects(
      GEMINI_APP_URL,
      cookieHeader,
      10,
      AbortSignal.timeout(1e4)
    );
    const email = extractEmailFromGeminiHtml(html);
    if (email) return email;
  } catch {
  }
  try {
    const response = await fetchWithCookieRedirects(
      GOOGLE_LIST_ACCOUNTS_URL,
      cookieHeader,
      10,
      AbortSignal.timeout(1e4)
    );
    return extractEmailFromListAccounts(response);
  } catch {
    return null;
  }
}
async function queryWithCookies(prompt, cookieMap, options = {}) {
  const model = options.model ?? DEFAULT_GEMINI_WEB_MODEL;
  if (!MODEL_HEADERS[model]) {
    throw new Error(`Gemini Web does not support model ${model}; configure Gemini API or choose a supported Gemini Web model.`);
  }
  const timeoutMs = options.timeoutMs ?? 12e4;
  let fullPrompt = prompt;
  if (options.youtubeUrl) {
    fullPrompt = `${fullPrompt}

YouTube video: ${options.youtubeUrl}`;
  }
  const result = await runGeminiWebOnce(fullPrompt, cookieMap, model, options.files, timeoutMs, options.signal);
  if (result.errorMessage) throw new Error(result.errorMessage);
  if (!result.text) throw new Error("Gemini Web returned empty response");
  return result.text;
}
async function runGeminiWebOnce(prompt, cookieMap, model, files, timeoutMs, signal) {
  const effectiveSignal = withTimeout2(signal, timeoutMs);
  const cookieHeader = buildCookieHeader2(cookieMap);
  const accessToken = await fetchAccessToken(cookieHeader, effectiveSignal);
  const uploaded = [];
  if (files) {
    for (const file of files) {
      uploaded.push(await uploadFile(file, cookieHeader, effectiveSignal));
    }
  }
  const fReq = buildFReqPayload(prompt, uploaded);
  const params = new URLSearchParams();
  params.set("at", accessToken);
  params.set("f.req", fReq);
  const res = await (await resolveGeminiFetch())(GEMINI_STREAM_GENERATE_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      host: "gemini.google.com",
      origin: "https://gemini.google.com",
      referer: "https://gemini.google.com/",
      "x-same-domain": "1",
      "user-agent": USER_AGENT,
      cookie: cookieHeader,
      [MODEL_HEADER_NAME]: MODEL_HEADERS[model]
    },
    body: params.toString(),
    signal: effectiveSignal
  });
  const rawText = await res.text();
  if (!res.ok) {
    return { text: "", errorMessage: `Gemini request failed: ${res.status}` };
  }
  try {
    return parseStreamGenerateResponse(rawText);
  } catch (err) {
    return {
      text: "",
      errorMessage: err instanceof Error ? err.message : String(err)
    };
  }
}
async function fetchAccessToken(cookieHeader, signal) {
  const html = await fetchWithCookieRedirects(GEMINI_APP_URL, cookieHeader, 10, signal);
  for (const key of ["SNlM0e", "thykhd"]) {
    const match = html.match(new RegExp(`"${key}":"(.*?)"`));
    if (match?.[1]) return match[1];
  }
  throw new Error("Unable to authenticate with Gemini. Make sure you're signed into gemini.google.com in a supported Chromium-based browser.");
}
async function fetchWithCookieRedirects(url, cookieHeader, maxRedirects, signal) {
  let current = url;
  const allowedOrigin = new URL(url).origin;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await (await resolveGeminiFetch())(current, {
      headers: { "user-agent": USER_AGENT, cookie: cookieHeader },
      redirect: "manual",
      signal
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        const next = new URL(location, current);
        if (next.origin !== allowedOrigin) {
          throw new Error(`Refusing to send Google cookies across origins: ${allowedOrigin} -> ${next.origin}`);
        }
        current = next.toString();
        continue;
      }
    }
    return await res.text();
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}
function extractEmailFromGeminiHtml(html) {
  const patterns = [
    // Gemini bootstraps the active account in oPEP7c. Prefer it over generic
    // feature/config entries that may contain other signed-in Google accounts.
    /"oPEP7c"\s*:\s*"([^"]+)"/,
    // The Google account menu aria-label is rendered for the active account.
    /aria-label="Google Account:[^"]*?\(([^)]+)\)"/,
    /"displayEmail"\s*:\s*"([^"]+)"/,
    /"defaultEmail"\s*:\s*"([^"]+)"/,
    /"email"\s*:\s*"([^"]+)"/,
    /"identifier"\s*:\s*"([^"]+)"/,
    /"gaiaIdentifier"\s*:\s*"([^"]+)"/
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const email = normalizeEmail(match?.[1]);
    if (email) return email;
  }
  return findFirstEmail(html);
}
function extractEmailFromListAccounts(text) {
  const trimmed = text.replace(/^\)\]\}'\s*/, "");
  try {
    return findEmailInValue(JSON.parse(trimmed)) ?? findFirstEmail(trimmed);
  } catch {
    return findFirstEmail(trimmed);
  }
}
function findEmailInValue(value) {
  if (typeof value === "string") return normalizeEmail(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = findEmailInValue(item);
      if (email) return email;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const email = findEmailInValue(item);
      if (email) return email;
    }
  }
  return null;
}
function findFirstEmail(text) {
  const normalized = decodeEmailEscapes(text);
  const match = normalized.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match?.[0] ?? null;
}
function normalizeEmail(value) {
  if (!value) return null;
  const normalized = decodeEmailEscapes(value.trim());
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalized) ? normalized : null;
}
function decodeEmailEscapes(value) {
  return value.replace(/\\u0040/gi, "@").replace(/\\x40/gi, "@").replace(/&#64;/gi, "@").replace(/&commat;/gi, "@").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
async function uploadFile(file, cookieHeader, signal) {
  const data = readFileSync4(file.path);
  const fileName = basename2(file.path);
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const header = `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${fileName}"\r
Content-Type: ${file.mimeType}\r
\r
`;
  const footer = `\r
--${boundary}--\r
`;
  const body = Buffer.concat([
    Buffer.from(header, "utf-8"),
    data,
    Buffer.from(footer, "utf-8")
  ]);
  const res = await (await resolveGeminiFetch())(GEMINI_UPLOAD_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "push-id": GEMINI_UPLOAD_PUSH_ID,
      "user-agent": USER_AGENT,
      cookie: cookieHeader
    },
    body,
    signal
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File upload failed: ${res.status} (${text.slice(0, 200)})`);
  }
  return { id: await res.text(), name: fileName };
}
function buildFReqPayload(prompt, uploaded) {
  const promptPayload = uploaded.length > 0 ? [prompt, 0, null, uploaded.map((file) => [[file.id, 1], file.name])] : [prompt];
  const innerList = [promptPayload, null, null];
  return JSON.stringify([null, JSON.stringify(innerList)]);
}
function withTimeout2(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function buildCookieHeader2(cookieMap) {
  return Object.entries(cookieMap).filter(([, value]) => typeof value === "string" && value.length > 0).map(([name, value]) => `${name}=${value}`).join("; ");
}
function getNestedValue(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (current == null) return void 0;
    if (!Array.isArray(current)) return void 0;
    current = current[part];
  }
  return current;
}
function trimJsonEnvelope(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain a JSON payload.");
  }
  return text.slice(start, end + 1);
}
function extractCandidateText(candidate) {
  const textRaw = getNestedValue(candidate, [1, 0]);
  let text = typeof textRaw === "string" ? textRaw : "";
  if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) {
    const alt = getNestedValue(candidate, [22, 0]);
    if (typeof alt === "string" && alt.length > 0) text = alt;
  }
  return text;
}
function parseStreamGenerateResponse(rawText) {
  const responseJson = JSON.parse(trimJsonEnvelope(rawText));
  const parts = Array.isArray(responseJson) ? responseJson : [];
  let latestNonEmptyText = "";
  for (let i = 0; i < parts.length; i++) {
    const partBody = getNestedValue(parts[i], [2]);
    if (!partBody || typeof partBody !== "string") continue;
    try {
      const parsed = JSON.parse(partBody);
      const candidateList = getNestedValue(parsed, [4]);
      if (!Array.isArray(candidateList) || candidateList.length === 0) continue;
      const firstCandidate = candidateList[0];
      const text = extractCandidateText(firstCandidate);
      if (text.length > 0) latestNonEmptyText = text;
    } catch {
    }
  }
  return { text: latestNonEmptyText };
}

// src/pi-web-access/perplexity.ts
var PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
var PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
var CONFIG_PATH10 = webCredentialsPath();
var REQUEST_TIMEOUT_MS2 = 6e4;
var RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 60 * 1e3
};
var requestTimestamps = [];
var cachedConfig12 = null;
function loadConfig11() {
  return cachedConfig12 ??= loadWebAccessConfig();
}
async function getApiKey9(signal) {
  const key = await resolveCredential({
    provider: "Perplexity",
    configuredValue: loadConfig11().perplexityApiKey,
    environmentValue: process.env.PERPLEXITY_API_KEY,
    signal
  });
  if (!key) {
    throw new Error(
      `Perplexity API key not found. Either:
  1. Create ${CONFIG_PATH10} with { "perplexityApiKey": "your-key" }
  2. Set PERPLEXITY_API_KEY environment variable
Get a key at https://perplexity.ai/settings/api`
    );
  }
  return key;
}
function checkRateLimit() {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT.windowMs;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
    const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
    throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1e3)}s`);
  }
  requestTimestamps.push(now);
}
function isPerplexityAvailable() {
  return hasCredentialSource({
    provider: "Perplexity",
    configuredValue: loadConfig11().perplexityApiKey,
    environmentValue: process.env.PERPLEXITY_API_KEY
  });
}
async function postPerplexity(url, body, options) {
  checkRateLimit();
  const apiKey = await getApiKey9(options.signal);
  options.signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS2);
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  const activityId = activityMonitor.logStart({ type: "api", query: options.activityQuery });
  activityMonitor.updateRateLimit({
    used: requestTimestamps.length,
    max: RATE_LIMIT.maxRequests,
    oldestTimestamp: requestTimestamps[0] ?? null,
    windowMs: RATE_LIMIT.windowMs
  });
  try {
    const response = await fetchWithCredentialRedirects(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    }, ["Authorization"]);
    if (!response.ok) {
      const errorText = redactCredential(await response.text(), apiKey);
      throw new SearchHttpError(response.status, `Perplexity API error ${response.status}: ${errorText}`);
    }
    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(`Perplexity API returned invalid JSON: ${err.message}`);
    }
    activityMonitor.logComplete(activityId, response.status);
    return data;
  } catch (err) {
    if (options.signal?.aborted) {
      activityMonitor.logComplete(activityId, 0);
      throw new Error("Aborted");
    }
    const message = err instanceof Error ? err.message : String(err);
    const redactedMessage = timeoutSignal.aborted || err instanceof Error && err.name === "TimeoutError" ? "Perplexity request timed out after 60s" : redactCredential(message, apiKey);
    if (err instanceof SearchHttpError) activityMonitor.logComplete(activityId, err.status);
    else activityMonitor.logError(activityId, redactedMessage);
    if (redactedMessage === message) throw err;
    const redactedError = err instanceof SearchHttpError ? new SearchHttpError(err.status, redactedMessage) : new Error(redactedMessage);
    throw redactedError;
  }
}
async function searchWithPerplexity(query, options = {}) {
  const numResults = normalizeSearchResultCount(options.numResults);
  const requestBody = {
    query,
    max_results: numResults,
    search_type: "fast",
    search_context_size: "medium"
  };
  if (options.recencyFilter) {
    requestBody.search_recency_filter = options.recencyFilter;
  }
  if (options.domainFilter && options.domainFilter.length > 0) {
    const filters = normalizeDomainFilters(options.domainFilter);
    const validated = [...filters.include, ...filters.exclude.map((domain) => `-${domain}`)];
    if (validated.length > 0) {
      requestBody.search_domain_filter = validated;
    }
  }
  const data = await postPerplexity(PERPLEXITY_SEARCH_URL, requestBody, { activityQuery: query, signal: options.signal });
  const results = [];
  for (const entry of Array.isArray(data.results) ? data.results : []) {
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || !entry.url) continue;
    results.push({
      title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
      url: entry.url,
      snippet: typeof entry.snippet === "string" ? entry.snippet.trim() : ""
    });
    if (results.length >= numResults) break;
  }
  return { answer: formatSearchResultsAsAnswer(results), results };
}
async function askPerplexity(prompt, options = {}) {
  const data = await postPerplexity(PERPLEXITY_CHAT_URL, {
    model: "sonar",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1024,
    return_related_questions: false
  }, { activityQuery: prompt, signal: options.signal });
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export {
  isLoopbackHostname,
  normalizeProxyUrl,
  runWithProxy,
  webFetch,
  formatSeconds,
  readExecError,
  isTimeoutError,
  trimErrorText,
  mapFfmpegError,
  activityMonitor,
  checkGhAvailable,
  showGhHint,
  extractGitHub,
  touchClones,
  releaseClonesUnusedSince,
  clearCloneCache,
  CredentialResolutionError,
  redactCredential,
  toRequestHeaders,
  requireProviderCredential,
  hasCredentialSource,
  resolveCredential,
  SearchUnsupportedFilterError,
  SearchHttpError,
  errorMessage,
  redactSearchFailure,
  normalizeSearchBaseUrl,
  normalizeSearchHeaders,
  resolveApiBaseUrl,
  fetchWithCredentialRedirects,
  GOOGLE_RECENCY_TBS,
  isGeminiAdcAvailable,
  DEFAULT_MODEL,
  getApiKey8 as getApiKey,
  getVersionedApiBase,
  getUploadBase,
  isGatewayConfigured,
  redactGeminiApiResponse,
  fetchGeminiApi,
  isGeminiApiAvailable,
  isGeminiApiAvailableWithVideo,
  queryGeminiApiWithInlineData,
  queryGeminiApiWithVideo,
  isBrowserCookieAccessAllowed,
  getBrowserCookiesForHosts,
  getGeminiWebAvailability,
  isGeminiWebAvailable,
  getGeminiWebAvailabilityDiagnostic,
  getGeminiWebAvailabilityDiagnosticDetails,
  getActiveGoogleEmail,
  queryWithCookies,
  normalizeDomain,
  normalizeDomainFilters,
  buildSiteFilteredQuery,
  matchesDomainFilter,
  extractSnippetAround,
  extractAnswer,
  normalizeSearchText,
  formatSearchResultAsAnswer,
  formatSearchResultsAsAnswer,
  normalizeSearchResultCount,
  isPerplexityAvailable,
  searchWithPerplexity,
  askPerplexity,
  isParallelAvailable,
  searchWithParallel,
  extractWithParallel,
  isParallelMcpAvailable,
  searchWithParallelMcp,
  extractWithParallelMcp,
  isTinyFishAvailable,
  searchWithTinyFish,
  extractWithTinyFish,
  isSearch1APIAvailable,
  searchWithSearch1API,
  extractWithSearch1API,
  isQueritAvailable,
  searchWithQuerit,
  extractWithQuerit,
  loadFetchContentDomainPolicy,
  loadSsrfConfig,
  validateRemoteUrl,
  fetchRemoteUrl,
  isFirecrawlAvailable,
  searchWithFirecrawl,
  extractWithFirecrawl,
  isKagiAvailable,
  searchWithKagi,
  isKagiExtractAvailable,
  extractWithKagi,
  isOllamaAvailable,
  searchWithOllama,
  isOllamaFetchAvailable,
  extractWithOllama,
  resolveAuthFetchProfile,
  assertAuthFetchUrl,
  authFetchRedirectGuard
};
