import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { c as archive } from "tar";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const launcher = path.join(root, "src/neural-search/assets/semantic/linux-x64/bin/sgrep");
const installer = path.join(root, "src/neural-search/runtime/install.mjs");
const linux = process.platform === "linux" && process.arch === "x64";
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metis-semantic-install-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = path.join(directory, "metis/neural-search/semantic/linux-x64");
  fs.mkdirSync(base, { recursive: true });
  return { directory, base, env: { ...process.env, METIS_SEMANTIC_AGENT_DIR: directory } };
}

test("package prepares semantic automatically without a manual installer or host SDK dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.postinstall, /src\/neural-search\/runtime\/install\.mjs/);
  assert.equal(pkg.scripts["prepare:semantic"], undefined);
  assert.equal(fs.existsSync(path.join(root, "scripts/prepare-semantic.mjs")), false);
  assert.doesNotMatch(fs.readFileSync(installer, "utf8"), /from ["']@earendil-works\//);
  assert.match(fs.readFileSync(launcher, "utf8"), /^#!\/bin\/sh\n/);
});

test("missing runtime points to normal Pi update instead of a manual deployment command", { skip: !linux }, t => {
  const { env } = fixture(t);
  const result = spawnSync(launcher, ["--version"], { env, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /pi update --extensions/);
  assert.doesNotMatch(result.stderr, /--from|prepare:semantic/);
});

test("launcher exec preserves PID, argv and selected runtime independently of cwd", { skip: !linux }, t => {
  const { base, env } = fixture(t);
  const runtime = path.join(base, "runtime-ABC123");
  fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "parsers"));
  fs.writeFileSync(path.join(runtime, "bin/sgrep"),
    '#!/bin/sh\nprintf "%s\\n" "$$" "$SGREP_RUNTIME_DIR" "$TREE_SITTER_LANGUAGE_PACK_CACHE_DIR" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(base, "current"), "runtime-ABC123\n");
  delete env.TREE_SITTER_LANGUAGE_PACK_CACHE_DIR;
  const result = spawnSync(launcher, ["query with spaces", "--", "/literal/path"], { env, cwd: "/", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"),
    [String(result.pid), runtime, path.join(runtime, "parsers"), "query with spaces", "--", "/literal/path"]);
  fs.writeFileSync(path.join(base, "current"), "../../outside\n");
  const invalid = spawnSync(launcher, [], { env, encoding: "utf8" });
  assert.equal(invalid.status, 78);
  assert.match(invalid.stderr, /Invalid semantic runtime selection/);
});

test("automatic setup reuses models across engine updates and preserves the old selection on failure", { skip: !linux }, async t => {
  fs.mkdirSync(path.join(root, ".work"), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, ".work/semantic-install-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(installer, path.join(directory, "install.mjs"));
  const agent = path.join(directory, "agent");
  const base = path.join(agent, "metis/neural-search/semantic/linux-x64");
  const counts = {};
  const payloads = new Map();
  const server = http.createServer((request, response) => {
    counts[request.url] = (counts[request.url] ?? 0) + 1;
    const body = payloads.get(request.url);
    response.writeHead(body ? 200 : 404);
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const address = `http://127.0.0.1:${server.address().port}`;
  async function asset(name, files) {
    const source = path.join(directory, name);
    const sizes = {};
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.writeFileSync(path.join(source, file), content, { mode: file === "bin/sgrep" ? 0o755 : 0o644 });
      sizes[file] = Buffer.byteLength(content);
    }
    const target = path.join(directory, `${name}.tar.gz`);
    await archive({ file: target, cwd: source, gzip: true, portable: true }, Object.keys(files));
    const body = fs.readFileSync(target);
    payloads.set(`/${name}.tar.gz`, body);
    return { id: name, url: `${address}/${name}.tar.gz`, bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"), files: sizes };
  }
  // Only the verifier process boundary is substituted here; actual model ABI/inference is accepted separately in .work.
  const verifier = '#!/bin/sh\nprintf \'{"runtime_check":1,"models":["bekko128","lateon-edge"]}\\n\'\n';
  const engine = await asset("engine-one", { "bin/sgrep": verifier, "lib/native": "native data" });
  const models = {};
  for (const name of ["bekko128", "lateon-edge"]) {
    const body = `immutable ${name} weights`;
    const value = await asset(`model-${name}`, { "weights.bin": body });
    delete value.files;
    models[name] = { ...value, catalog: { revision: "fixture", files: {
      "weights.bin": { bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") },
    } } };
  }
  let distribution = { format_version: 1, id: "runtime-one", engine, models };
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, METIS_SEMANTIC_AGENT_DIR: agent, NO_PROXY: "127.0.0.1",
    PI_OFFLINE: "0", HF_HUB_OFFLINE: "0" };
  delete env.SGREP_RUNTIME_DIR;
  const setup = () => {
    fs.writeFileSync(path.join(directory, "distribution.json"), JSON.stringify(distribution));
    return run(process.execPath, [path.join(directory, "install.mjs")], { env, timeout: 20_000 });
  };
  const selected = () => path.join(base, fs.readFileSync(path.join(base, "current"), "utf8").trim());
  const modelPaths = () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(selected(), "assets.json"), "utf8"));
    return Object.fromEntries(Object.entries(catalog.models).map(([name, value]) => [name, value.directory]));
  };
  await setup();
  const paths = modelPaths();
  assert.deepEqual(Object.values(counts), [1, 1, 1]);
  await setup();
  assert.deepEqual(Object.values(counts), [1, 1, 1]);
  const nextEngine = await asset("engine-two", { "bin/sgrep": verifier + "# second engine\n", "lib/native": "new native data" });
  distribution = { ...distribution, id: "runtime-two", engine: nextEngine };
  await setup();
  assert.deepEqual(modelPaths(), paths);
  assert.equal(counts["/engine-two.tar.gz"], 1);
  for (const name of Object.keys(models)) assert.equal(counts[`/model-${name}.tar.gz`], 1);
  const previous = selected();
  const failed = await asset("engine-broken", { "bin/sgrep": "#!/bin/sh\necho controlled-native-failure >&2\nexit 2\n" });
  distribution = { ...distribution, id: "runtime-broken", engine: failed };
  await assert.rejects(setup(), /controlled-native-failure/);
  assert.equal(selected(), previous);
  assert.deepEqual(modelPaths(), paths);
  for (const name of Object.keys(models)) assert.equal(counts[`/model-${name}.tar.gz`], 1);
  const requests = { ...counts };
  distribution = { ...distribution, minimum_glibc: "99.0" };
  const unsupported = await setup();
  assert.match(unsupported.stdout, /Other Metis features remain available/);
  assert.equal(selected(), previous);
  assert.deepEqual(counts, requests);
});
