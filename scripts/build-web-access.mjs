#!/usr/bin/env node
// Builds the Web bundles with externals from the root dependency owner.
//
// Declared dependencies and peerDependencies stay external: they resolve from
// node_modules at runtime, and the running pi host provides @earendil-works/*
// as jiti virtual modules. Deriving the list keeps future dependencies
// external automatically instead of silently bundling them into dist.
// node:* builtins are covered by platform "node".
//
// The standalone MCP bin (dist/mcp-cli.js) bundles typebox: it stays a
// pi-hosted peer for the extension, but the bin must run without Pi installed.
import { chmodSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const externals = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  "@earendil-works/*",
];

const configModules = {
  name: "metis-config-origin",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/(metis-config|web-access-config)\.ts$/ }, ({ path }) => ({
      path: `../../${path.slice(3)}`,
      external: true,
    }));
  },
};
const options = {
  bundle: true, format: "esm", platform: "node", target: "node22.19",
  absWorkingDir: root, outdir: "src/pi-web-access/dist", outbase: "src/pi-web-access",
  logLevel: "info", plugins: [configModules],
};
await build({ ...options, entryPoints: ["src/pi-web-access/index.ts"], external: externals });
await build({ ...options, entryPoints: ["src/pi-web-access/mcp-cli.ts"], external: externals.filter((name) => name !== "typebox") });
chmodSync(new URL("../src/pi-web-access/dist/mcp-cli.js", import.meta.url), 0o755);
