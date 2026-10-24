import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const fileHash = path => hash(readFileSync(path));

// Minimal PE32+ reader shared by the Windows asset builders. It only reports the
// facts a manifest records; each asset keeps its own acceptance policy.
export function peInfo(path) {
  const image = readFileSync(path);
  const u16 = offset => image.readUInt16LE(offset);
  const u32 = offset => image.readUInt32LE(offset);
  const text = rva => {
    const pointer = offsetOf(rva);
    const end = image.indexOf(0, pointer);
    if (end < 0) throw new Error(`${path}: unterminated string at RVA ${rva}`);
    return image.toString("latin1", pointer, end);
  };
  if (image.length < 0x40 || u16(0) !== 0x5a4d) throw new Error(`${path}: not a PE image`);
  const coff = u32(0x3c);
  if (u32(coff) !== 0x00004550) throw new Error(`${path}: missing PE signature`);
  const machine = u16(coff + 4);
  const sectionCount = u16(coff + 6);
  const optionalSize = u16(coff + 20);
  const characteristics = u16(coff + 22);
  const optional = coff + 24;
  if (u16(optional) !== 0x20b) throw new Error(`${path}: expected a PE32+ (x64) image`);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const entry = optional + optionalSize + index * 40;
    sections.push({ size: Math.max(u32(entry + 8), u32(entry + 16)), address: u32(entry + 12), raw: u32(entry + 20) });
  }
  const offsetOf = rva => {
    const section = sections.find(entry => rva >= entry.address && rva < entry.address + entry.size);
    if (!section) throw new Error(`${path}: RVA ${rva} is outside every section`);
    return section.raw + (rva - section.address);
  };
  const directoryRva = index => u32(optional + 112 + index * 8);
  const exports = [];
  const exportTable = directoryRva(0);
  if (exportTable) {
    const base = offsetOf(exportTable);
    const names = offsetOf(u32(base + 32));
    for (let index = 0; index < u32(base + 24); index++) exports.push(text(u32(names + index * 4)));
  }
  const imports = [];
  const importTable = directoryRva(1);
  if (importTable) {
    for (let entry = offsetOf(importTable); u32(entry + 12); entry += 20) imports.push(text(u32(entry + 12)));
  }
  const sorted = values => [...new Set(values)].sort();
  return { machine: machine === 0x8664 ? "x86-64" : `0x${machine.toString(16)}`, dll: (characteristics & 0x2000) !== 0, exports: sorted(exports), imports: sorted(imports) };
}

// Both asset manifests record the same ordered, repo-relative source format.
export function sourceInputs(root, directory, include, extra = []) {
  const collect = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "target") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && include(entry.name)
      ? [{ path: relative(root, path).split(sep).join("/"), sha256: fileHash(path) }] : [];
  });
  const inputs = collect(directory);
  for (const path of extra) inputs.push({ path, sha256: fileHash(join(root, path)) });
  return inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
