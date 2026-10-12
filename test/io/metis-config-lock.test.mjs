import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const [mode, directory, role] = process.argv.slice(2);
if (mode === 'writer') {
  const originalRead = fs.readFileSync;
  let intercepted = false;
  fs.readFileSync = function (path, ...args) {
    const value = originalRead.call(this, path, ...args);
    if (!intercepted && String(path) === join(directory, 'metis-pi.toml')) {
      intercepted = true;
      fs.writeFileSync(join(directory, `read-${role}`), 'entered');
      if (role === 'first') {
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(join(directory, 'release'))) Atomics.wait(wait, 0, 0, 10);
      }
    }
    return value;
  };
  syncBuiltinESMExports();
  const { updateMetisConfig } = await import('../../src/metis-config.ts');
  fs.writeFileSync(join(directory, `ready-${role}`), String(process.pid));
  updateMetisConfig(directory, role === 'first'
    ? { sessionRecall: { queryModel: 'openai/process-proof' } }
    : { appearance: { enabled: false } });
} else test('concurrent config writers preserve independent patches', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'metis-process-lock-'));
  fs.writeFileSync(join(dir, 'metis-pi.toml'), '[sessionRecall]\nqueryModel="default"\n');
  const children = [];
  const completions = [];
  const start = role => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), 'writer', dir, role]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `writer exit ${code}`)));
    });
    children.push(child);
    completions.push(done);
    void done.catch(() => {});
    return done;
  };
  const until = async predicate => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert.ok(predicate(), 'writer reached the controlled source read');
  };
  try {
    const first = start('first');
    await until(() => fs.existsSync(join(dir, 'read-first')));
    const second = start('second');
    await until(() => fs.existsSync(join(dir, 'ready-second')));
    await delay(300);
    assert.equal(fs.existsSync(join(dir, 'read-second')), false, 'second process waits before reading');
    fs.writeFileSync(join(dir, 'release'), 'go');
    await Promise.all([first, second]);
    const { readMetisConfig } = await import('../../src/metis-config.ts');
    const saved = readMetisConfig(dir).config;
    assert.equal(saved.sessionRecall.queryModel, 'openai/process-proof');
    assert.equal(saved.appearance.enabled, false);
    assert.notEqual(children[0].pid, children[1].pid);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(completions);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
