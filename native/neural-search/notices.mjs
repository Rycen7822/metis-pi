import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Include Rust dependency notices, including the C libraries bundled by *-sys
// crates. Cargo's SPDX field alone does not contain their copyright notices.
export function writeNotices(root, source) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", join(source, "Cargo.toml"),
    "--locked", "--format-version", "1", "--filter-platform", "x86_64-unknown-linux-gnu"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  const graph = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const closure = new Set([metadata.packages.find(pkg => pkg.name === "fff-c").id]);
  for (const id of closure) for (const dep of graph.get(id).deps)
    if (dep.dep_kinds.some(kind => kind.kind !== "dev")) closure.add(dep.pkg);

  function licenses(directory, base = directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return /^(?:\.git|tests?|benches|examples|fixtures|target)$/i.test(entry.name) ? [] : licenses(path, base);
      return entry.isFile() && /^(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)(?:$|[-_.])/i.test(entry.name)
        ? [{ name: relative(base, path), text: readFileSync(path, "utf8") }] : [];
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  const rows = [...closure].map(id => packages.get(id)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version.localeCompare(b.version));
  const sections = ["Metis Neural Search — Rust and bundled native dependency notices", "Generated from the locked Linux x64 runtime/build dependency closure; dev-only dependencies are excluded."];
  for (const pkg of rows) {
    const directory = dirname(pkg.manifest_path);
    const supplied = join(source, "licenses", `${pkg.name}-${pkg.version}`);
    let files = existsSync(supplied) ? licenses(supplied) : licenses(directory);
    if (!pkg.source) files = [{ name: "LICENSE", text: readFileSync(join(source, "LICENSE"), "utf8") }];
    const licenseFile = pkg.license_file && resolve(directory, pkg.license_file);
    if (licenseFile && !files.some(file => file.name === relative(directory, licenseFile)))
      files.push({ name: relative(directory, licenseFile), text: readFileSync(licenseFile, "utf8") });
    if (!files.length) throw new Error(`No distributed license text found for ${pkg.name} ${pkg.version}`);
    sections.push(`\n${"=".repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "see supplied license"}\n${pkg.repository ?? ""}\n${(pkg.authors ?? []).join("; ")}`);
    for (const file of files) sections.push(`--- ${file.name} ---\n${file.text}`);
  }
  const output = join(root, "assets/neural-search");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), sections.join("\n\n") + "\n");
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const standardLibraryNotices = join(sysroot, "share/doc/rust/COPYRIGHT-library.html");
  if (!existsSync(standardLibraryNotices)) throw new Error("Rust standard-library notices missing; install the rust-docs component before building.");
  copyFileSync(standardLibraryNotices, join(output, "RUST-STDLIB-NOTICES.html"));
}
