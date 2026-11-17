import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const marker = "metis-sdk.json";
const releaseName = /^metis-(\d+\.\d+\.\d+)-([0-9a-f]{12})-[0-9a-f]{8}$/;
const isHash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const normalize = value => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;

async function readProc(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return undefined; throw error; }
}

async function linuxInUse(root, obsolete) {
  const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n");
  for (const line of mounts) {
    const mount = line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (mount && obsolete.some(dir => mount === dir || mount.startsWith(dir + "/"))) return true;
  }

  const uid = process.getuid();
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const dir = "/proc/" + pid;
    const name = (await readProc(dir + "/comm"))?.trim();
    if (!name || !/^(pi(?:-rpc)?|node(?:js)?|bun)$/.test(name)) continue;
    const owner = await lstat(dir).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (owner?.uid !== uid) continue;
    const command = await readProc(dir + "/cmdline");
    if (!command) continue; // Exited or zombie.
    if (obsolete.some(directory => command.includes(directory + "/"))) return true;
    if (name !== "pi" && name !== "pi-rpc") continue;
    // Pi overwrites argv with its process title; an older launcher may not identify its release.
    const env = await readProc(dir + "/environ");
    if (env === undefined) continue;
    const prefix = "PI_MANAGED_INSTALL_ROOT=";
    const managed = env.split("\0").find(entry => entry.startsWith(prefix))?.slice(prefix.length);
    if (!managed || await realpath(managed).catch(() => root) === root) return true;
  }
  return false;
}

async function windowsInUse(obsolete) {
  // Windows retains the executable command line even when Pi changes the console title.
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    "$p = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bun.exe' OR Name='pi.exe' OR Name='pi-rpc.exe'\" | " +
    "Select-Object ProcessId, CommandLine); ConvertTo-Json -InputObject $p -Compress";
  const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5000, windowsHide: true });
  const paths = obsolete.map(directory => normalize(directory) + "/");
  return JSON.parse(stdout).some(({ ProcessId, CommandLine }) => {
    if (ProcessId === process.pid) return false;
    if (!CommandLine) return true;
    const command = normalize(CommandLine);
    return paths.some(directory => command.includes(directory));
  });
}

async function ownedRelease(releases, entry) {
  const identity = releaseName.exec(entry.name);
  if (!identity || !entry.isDirectory()) return undefined;
  const dir = path.join(releases, entry.name);
  if (normalize(await realpath(dir)) !== normalize(dir)) return undefined;
  const file = path.join(dir, marker);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const data = JSON.parse(await readFile(file, "utf8"));
    if (data?.schemaVersion === 1 && data.piVersion === identity[1] && isHash(data.patchSet) &&
      data.patchSet.startsWith(identity[2]) && isHash(data.archiveHash)) return dir;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

/** Call under the install lock, after activation. Inconclusive process checks leave releases alone. */
export async function pruneReleases(releases, { active, previous, runningRelease }) {
  if (process.platform !== "linux" && process.platform !== "win32") return;
  if (normalize(await realpath(releases)) !== normalize(releases)) return;
  const entries = await readdir(releases, { withFileTypes: true });
  if (!entries.some(entry => entry.name === previous && entry.isDirectory())) return;
  const obsolete = [];
  const keep = new Set([active, previous, runningRelease].filter(Boolean).map(normalize));
  for (const entry of entries) {
    if (keep.has(normalize(entry.name))) continue;
    const dir = await ownedRelease(releases, entry);
    if (dir) obsolete.push(dir);
  }
  if (!obsolete.length) return;
  const inUse = process.platform === "linux"
    ? await linuxInUse(path.dirname(releases), obsolete) : await windowsInUse(obsolete);
  if (inUse) return;

  for (const dir of obsolete) {
    // Keep ownership evidence if recursive cleanup fails partway through (e.g. a Windows file lock).
    for (const child of await readdir(dir)) {
      if (child !== marker) await rm(path.join(dir, child), { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
}
