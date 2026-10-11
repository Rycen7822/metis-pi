#!/usr/bin/env node
// Builds the dist/ bundles with externals derived from package.json.
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
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
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
  outdir: "dist", outbase: ".", logLevel: "info", plugins: [configModules],
};
await build({ ...options, entryPoints: ["index.ts"], external: externals });
await build({ ...options, entryPoints: ["mcp-cli.ts"], external: externals.filter((name) => name !== "typebox") });
chmodSync("dist/mcp-cli.js", 0o755);
