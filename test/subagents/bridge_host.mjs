#!/usr/bin/env node
/**
 * Minimal Pi-host fixture that loads the REAL codex-mcp-bridge.ts through jiti
 * (the same TS loader Pi uses) and drives its registered tool directly. No Pi
 * process, no model call, no disk cache. Used by tests/test_bridge_host.py for
 * transport/policy/lifecycle evidence against local fake MCP servers.
 *
 * Usage: node bridge_host.mjs <payload.json> <actions.json> <result.json>
 * payload.json = bootstrap payload (agent/source/mcp)
 * actions.json = [{action,server,tool,args,confirm,abortAfterMs,closeAfterMs,
 *                  launch,awaitPending,name}]
 */
import { openSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

// Locate the installed Pi distribution (only used as a fallback for jiti/
// typebox when the project's pinned devDependencies are absent).
function findPiDir() {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  try {
    const exe = execSync('command -v pi', { shell: '/bin/bash' }).toString().trim();
    const real = realpathSync(exe);
    const parts = real.split('/');
    for (let i = parts.length; i >= 1; i--) {
      const parent = parts.slice(0, i).join('/');
      if (existsSync(join(parent, 'dist', 'index.d.ts'))) return parent;
    }
  } catch { /* pi not installed */ }
  return null;
}
const PI_DIR = findPiDir();
const require_ = createRequire(import.meta.url);
// jiti/typebox resolve from the project's pinned devDependencies when present,
// falling back to the installed Pi distribution (real-Pi loader parity).
let jitiEntry;
try { jitiEntry = require_.resolve('jiti', { paths: [process.cwd()] }); }
catch { jitiEntry = join(PI_DIR, 'node_modules', 'jiti', 'lib', 'jiti.mjs'); }
const { createJiti } = require_(jitiEntry);

const [payloadPath, actionsPath, resultPath] = process.argv.slice(2);
const actions = JSON.parse(readFileSync(actionsPath, 'utf8'));

// The bridge reads PI_AGENTS_BOOTSTRAP_FD to EOF, so a regular read-only fd of
// the payload file exercises the identical read/parse path. Receipt fd is a
// temp file the bridge writes and closes.
const bootstrapFd = openSync(payloadPath, 'r');
const receiptPath = join(dirname(resultPath), 'receipt.json');
const receiptFd = openSync(receiptPath, 'w', 0o600);
process.env.PI_AGENTS_BOOTSTRAP_FD = String(bootstrapFd);
process.env.PI_AGENTS_BRIDGE_RECEIPT_FD = String(receiptFd);

let typeboxEntry;
try { typeboxEntry = require_.resolve('typebox', { paths: [process.cwd()] }); }
catch { typeboxEntry = join(PI_DIR, 'node_modules', 'typebox', 'build', 'index.mjs'); }
const jiti = createJiti(import.meta.url, { alias: { typebox: typeboxEntry } });
const bridgePath = join(process.env.BRIDGE_TS, 'codex-mcp-bridge.ts');
const mod = await jiti.import(bridgePath);
const handlers = {};
let registered = null;
const piStub = {
  registerTool: (def) => { registered = def; },
  on: (event, cb) => { (handlers[event] ||= []).push(cb); },
};
await (mod.default ?? mod)(piStub); // Pi awaits the extension factory before continuing
// The bridge closed the bootstrap fd itself after reading it to EOF.

// The bridge factory awaits required-server initialization before writing the
// receipt, so by the time the factory resolved, the receipt file is written.
let receipt = null;
try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { /* missing receipt is a failure signal */ }

const results = [];
let confirmCount = 0;
const launched = [];
async function runStep(step) {
  const signal = new AbortController();
  let timer = null;
  if (step.abortAfterMs) timer = setTimeout(() => signal.abort(new Error('host abort')), step.abortAfterMs);
  if (step.closeAfterMs) {
    setTimeout(() => { for (const cb of handlers['session_shutdown'] ?? []) cb(); }, step.closeAfterMs);
  }
  try {
    const ctx = { ui: { confirm: async () => { confirmCount += 1; if (step.confirmDelayMs) await new Promise((r) => setTimeout(r, step.confirmDelayMs)); return step.confirm === true; } } };
    const out = await registered.execute('call-1', {
      action: step.action, server: step.server, tool: step.tool, args: step.args ?? {},
    }, signal.signal, null, ctx);
    results.push({ kind: 'result', step: step.name ?? step.action, text: out?.content?.[0]?.text ?? null, details: out?.details ?? {} });
  } catch (err) {
    results.push({ kind: 'error', step: step.name ?? step.action, name: err.name, message: String(err.message).slice(0, 500) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
for (const step of actions) {
  if (step.launch) { launched.push(runStep(step)); continue; } // fire and forget; awaited via awaitPending
  if (step.awaitPending) {
    await Promise.allSettled(launched.splice(0));
    continue;
  }
  if (step.waitMs) { await new Promise((r) => setTimeout(r, step.waitMs)); continue; }
  if (step.shutdown) { for (const cb of handlers['session_shutdown'] ?? []) cb(); continue; }
  if (step.socketCount) {
    results.push({ kind: 'snapshot', step: step.name, sockets: process._getActiveHandles().filter(
      (handle) => handle.constructor?.name === 'Socket' && handle.remoteAddress === '127.0.0.1',
    ).length });
    continue;
  }
  await runStep(step);
}
await Promise.allSettled(launched.splice(0)); // never leave a step unsettled

writeFileSync(resultPath, JSON.stringify({
  registered: registered ? { name: registered.name, parameters: registered.parameters, executionMode: registered.executionMode } : null,
  receipt,
  confirm_count: confirmCount,
  results,
}));
process.exit(0);
