#!/usr/bin/env node
// Prepare an isolated source build; never applies patches or changes an installed SDK.
import { chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [sourceArgument, dependenciesArgument] = process.argv.slice(2);
if (!sourceArgument || !dependenciesArgument) {
  throw new Error("Usage: node prepare-build.mjs <pi-source-checkout> <metis-node-modules>");
}
const source = resolve(sourceArgument);
const dependencies = resolve(dependenciesArgument);
const target = resolve(source, "node_modules");
const version = "1.5.1";
const manifest = async (directory) => JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
if ((await manifest(resolve(source, "packages/coding-agent"))).version !== version) {
  throw new Error(`This preparation recipe requires Pi ${version} source.`);
}
for (const name of ["pi-ai", "pi-tui", "pi-coding-agent", "pi-schema"]) {
  if ((await manifest(resolve(dependencies, "@earendil-works", name))).version !== version) {
    throw new Error(`Expected published ${name}@${version} in the supplied dependency tree.`);
  }
}

async function rejectLinks(directory) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) throw new Error(`Symlink not allowed: ${directory}`);
  if (metadata.isFile()) {
    if (metadata.nlink !== 1) throw new Error(`Hardlink not allowed: ${directory}`);
    return;
  }
  for (const entry of await readdir(directory)) await rejectLinks(resolve(directory, entry));
}
await rejectLinks(target);

async function copyMissingPackages(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const input = resolve(from, entry.name);
    const output = resolve(to, entry.name);
    if (entry.name.startsWith("@")) {
      await copyMissingPackages(input, output);
      continue;
    }
    try {
      await lstat(output);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await cp(input, output, { recursive: true, dereference: true, errorOnExist: true, force: false });
  }
}
await copyMissingPackages(dependencies, target);
for (const name of ["pi-ai", "pi-coding-agent"]) {
  const nested = resolve(dependencies, "@earendil-works", name, "node_modules");
  try { await lstat(nested); } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await copyMissingPackages(nested, target);
}

const rootManifest = await manifest(source);
const agentManifest = await manifest(resolve(source, "packages/coding-agent"));
for (const [name, expected] of [
  ["typescript", rootManifest.devDependencies.typescript],
  ["@biomejs/biome", rootManifest.devDependencies["@biomejs/biome"]],
  ["vitest", agentManifest.devDependencies.vitest],
]) {
  if ((await manifest(resolve(target, name))).version !== expected) {
    throw new Error(`Expected ${name}@${expected} from the source toolchain.`);
  }
}

// Start from real same-version artifacts; ai/tui/coding-agent builds then replace their owned dist outputs.
for (const entry of await readdir(resolve(source, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory() || ["tui", "coding-agent"].includes(entry.name)) continue;
  const workspace = resolve(source, "packages", entry.name);
  const metadata = await manifest(workspace);
  const published = resolve(target, metadata.name);
  let installed;
  try {
    installed = await manifest(published);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    continue;
  }
  if (installed.version !== metadata.version) throw new Error(`Version mismatch for ${metadata.name}`);
  await cp(resolve(published, "dist"), resolve(workspace, "dist"), { recursive: true, dereference: true });
}
await cp(resolve(target, "@earendil-works/pi-ai/dist/providers/data"),
  resolve(source, "packages/ai/src/providers/data"), { recursive: true, dereference: true });

// npm's workspace/bin links are disabled. These regular shell files preserve each tool's actual entry path.
await mkdir(resolve(target, ".bin"), { recursive: true });
for (const name of ["typescript", "@biomejs/biome", "vitest"]) {
  const metadata = await manifest(resolve(target, name));
  const bins = typeof metadata.bin === "string" ? { [name.split("/").at(-1)]: metadata.bin } : metadata.bin;
  for (const [command, path] of Object.entries(bins)) {
    const entry = resolve(target, ".bin", command);
    const body = '#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n' +
      `exec node "$basedir/../${name}/${path}" "$@"\n`;
    await writeFile(entry, body);
    await chmod(entry, 0o755);
  }
}
await rejectLinks(target);
console.log(`Prepared physical Pi ${version} build dependencies in ${source}; installed SDK untouched.`);
