import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import suites from "./condense/cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

function config(suite, item) {
  const constants = Object.entries({ ...suite.constants, ...item.constants }).map(([name, value]) => {
    if (typeof value === "object") return ` ${name} <- ${value.operator}`;
    const literal = typeof value === "boolean" ? String(value).toUpperCase() : JSON.stringify(value);
    return ` ${name} = ${literal}`;
  });
  const invariants = item.invariants ?? suite.invariants;
  const properties = item.properties ?? suite.properties ?? [];
  return [`SPECIFICATION ${item.spec ?? "Spec"}`, "CONSTANTS", ...constants,
    "INVARIANTS", ...invariants.map(name => ` ${name}`),
    ...(properties.length ? ["PROPERTIES", ...properties.map(name => ` ${name}`)] : []), ""].join("\n");
}

function run() {
  if (!process.env.TLA2TOOLS_JAR) throw new Error("Set TLA2TOOLS_JAR; see test/formal/README.md");
  const jar = resolve(process.env.TLA2TOOLS_JAR);
  if (!statSync(jar).isFile()) throw new Error(`Not a JAR file: ${jar}`);
  const requested = process.argv.slice(2);
  const unknown = requested.filter(name => !suites.some(suite => suite.module === name));
  if (unknown.length) throw new Error(`Unknown formal suite: ${unknown.join(", ")}`);
  const selected = suites.filter(suite => !requested.length || requested.includes(suite.module));
  const cases = selected.flatMap(suite => suite.cases.map(item => ({ suite, item })));
  if (!cases.length) throw new Error("No formal cases selected");
  mkdirSync(join(root, ".work"), { recursive: true });
  const output = mkdtempSync(join(root, ".work/formal-"));
  for (const file of readdirSync(join(here, "condense")).filter(file => file.endsWith(".tla")))
    copyFileSync(join(here, "condense", file), join(output, file));
  const results = [];
  console.log(`TLC logs/configs/states: ${output}`);
  for (const { suite, item } of cases) {
    const name = `${suite.module}-${item.name}`;
    writeFileSync(join(output, `${name}.cfg`), config(suite, item));
    const child = spawnSync("java", ["-Xmx1024m", "-XX:+UseParallelGC", "-XX:ActiveProcessorCount=2", "-cp", jar,
      "tlc2.TLC", "-cleanup", "-workers", "1", "-metadir", join(output, `${name}-states`),
      "-config", `${name}.cfg`, `${suite.module}.tla`],
    { cwd: output, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    const log = (child.stdout ?? "") + (child.stderr ?? "");
    writeFileSync(join(output, `${name}.log`), log);
    const invariant = /Invariant (\w+) is violated/.exec(log)?.[1];
    const expectedExit = item.expect?.temporal ? 13 : item.expect?.invariant ? 12 : 0;
    const completed = item.expect?.temporal ? /Temporal properties were violated/.test(log)
      : item.expect?.invariant ? invariant === item.expect.invariant
      : /Model checking completed\. No error has been found/.test(log);
    const matched = !child.error && !child.signal && child.status === expectedExit && completed;
    results.push({ name, expected: item.expect ?? "no error", exit: child.status,
      invariant, error: child.error?.message, signal: child.signal, matched });
    console.log(`${matched ? "OK" : "FAIL"} ${name} (${item.expect ? "expected counterexample" : "positive"})`);
    if (!matched) {
      console.error(child.error?.message ?? log.slice(-6000));
      break;
    }
  }
  const passed = results.length === cases.length && results.every(result => result.matched);
  writeFileSync(join(output, "results.json"), JSON.stringify({ requested: cases.length, passed, results }, null, 2));
  console.log(`${results.length}/${cases.length} checked; ${results.filter(r => r.expected !== "no error").length} controls`);
  if (!passed) process.exitCode = 1;
}

try { run(); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
