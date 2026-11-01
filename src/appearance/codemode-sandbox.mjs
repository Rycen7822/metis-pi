// Keep dependency loading native: the extension loader aliases Pi, not pi-codemode.
import { findPackageJSON } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sandboxClasses = new Map();

/** @param {string} sdkDirectory
 * @returns {Promise<typeof import("@earendil-works/pi-codemode").CodemodeSandboxBase>} */
export function loadNativeCodemodeSandboxClass(sdkDirectory) {
  let loaded = sandboxClasses.get(sdkDirectory);
  if (!loaded) {
    loaded = importSandboxClass(sdkDirectory);
    sandboxClasses.set(sdkDirectory, loaded);
  }
  return loaded;
}

/** @param {string} sdkDirectory */
async function importSandboxClass(sdkDirectory) {
  const manifest = findPackageJSON("@earendil-works/pi-codemode", pathToFileURL(join(sdkDirectory, "package.json")));
  if (!manifest) throw new Error("The active Pi SDK has no pi-codemode package");
  const { main } = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof main !== "string") throw new Error("The active pi-codemode package has no main entry");
  // Resolve the host's public package entry, not an extension-local dependency copy or a private SDK source file.
  const runtime = await import(pathToFileURL(resolve(dirname(manifest), main)).href);
  return runtime.CodemodeSandboxBase;
}
