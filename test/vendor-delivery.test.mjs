import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(t, changed = true) {
  const root = mkdtempSync(join(tmpdir(), "metis-vendor-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vendor = join(root, "vendor/pi-codex-conversion");
  const upstream = join(root, "references/howaboua-pi-stuff/packages/pi-codex-conversion");
  for (const dir of ["scripts", "bin", "vendor/pi-codex-conversion/patches"]) mkdirSync(join(root, dir), { recursive: true });
  for (const dir of [vendor, upstream]) mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(upstream, "src/value.ts"), "export const value = 1;\n");
  writeFileSync(join(vendor, "src/value.ts"), `export const value = ${changed ? 2 : 1};\n`);
  const patch = join(vendor, "patches/local.patch");
  writeFileSync(patch, "last known good patch\n");
  const script = join(root, "scripts/vendor-codex-conversion.mjs");
  writeFileSync(script, readFileSync(new URL("../scripts/vendor-codex-conversion.mjs", import.meta.url)));
  return {
    patch,
    run(gitBody) {
      if (gitBody !== undefined && gitBody !== null) {
        writeFileSync(join(root, "bin/git"), `#!${process.execPath}\n${gitBody}\n`, { mode: 0o700 });
      }
      return spawnSync(process.execPath, [script, "patch"], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ...(gitBody === undefined ? {} : { PATH: join(root, "bin") }) },
      });
    },
  };
}

for (const changed of [false, true]) {
  test(`vendor patch publishes a complete real git diff (changed=${changed})`, (t) => {
    const f = fixture(t, changed);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const patch = readFileSync(f.patch, "utf8");
    if (changed) {
      assert.match(patch, /^diff --git a\/src\/value\.ts b\/src\/value\.ts/m);
      assert.match(patch, /\+export const value = 2;/);
    } else assert.equal(patch, "", "exit 0 legitimately clears a now-empty patch");
  });
}

for (const [name, body] of [
  ["missing git", null],
  ["git failure with empty stdout", "process.exit(2)"],
  ["git failure with partial stdout", 'process.stdout.write("partial patch\\n", () => process.exit(2))'],
  ["git terminated by a signal", 'process.kill(process.pid, "SIGTERM")'],
  ["diff output exceeds execFileSync capacity", 'process.stdout.write("x".repeat(2 * 1024 * 1024), () => process.exit(1))'],
]) {
  test(`vendor patch preserves the last good artifact on ${name}`, (t) => {
    const f = fixture(t);
    const result = f.run(body);
    assert.notEqual(result.status, 0, "unexpected git failure must fail the delivery command");
    assert.equal(readFileSync(f.patch, "utf8"), "last known good patch\n");
    assert.doesNotMatch(result.stdout ?? "", /^patch:/m, "failure cannot report a published patch");
  });
}
