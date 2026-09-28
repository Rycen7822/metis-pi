import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Match Pi's native write/edit path normalization before filesystem access. */
export function resolveNativeMutationPath(cwd: string, path: string): string {
  let value = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu, " ").replace(/^@/, "");
  if (process.platform === "win32" && !value.includes("\\")) {
    value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_, drive: string, rest = "") => `${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`);
  }
  if (value.startsWith("file://")) value = fileURLToPath(value);
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return resolve(homedir(), value.slice(2));
  return resolve(cwd, value);
}
