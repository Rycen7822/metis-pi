import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { SubagentClient } from '../../src/subagents/host/client.ts';

const root = process.cwd();
const frame = (request, result) => Buffer.from(JSON.stringify({ id: request.id, ok: true, result }) + '\n');

function fixture(t, maxFrame = 1024) {
  const child = new EventEmitter(), requests = [];
  child.exitCode = child.signalCode = null;
  for (const pipe of ['stdin', 'stdout', 'stderr']) child[pipe] = new PassThrough();
  const exit = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString('utf8'));
    if (request.operation === 'initialize') {
      queueMicrotask(() => child.stdout.emit('data', frame(request, { scope: 'offline-scope', boot_timeout: 1 })));
    } else {
      requests.push(request);
      child.emit('request');
    }
  });
  child.stdin.on('finish', exit).on('close', exit);
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  const client = new SubagentClient({ root, tools: [], scopeEnvKeys: [], maxFrame }, {
    cwd: root, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'offline-session', getSessionFile: () => undefined },
  }, root, undefined, scope => assert.equal(scope, 'offline-scope'));
  t.after(async () => {
    try { await client.close(); }
    finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.destroy().removeAllListeners();
      child.removeAllListeners();
    }
    assert.equal(child.exitCode, 0, 'mock bridge exited and request timers were cleaned');
  });
  return { client, child, requests, async next() {
    if (!requests.length) await once(child, 'request');
    return requests.shift();
  } };
}

test('RPC responses preserve UTF8 across fragmented/chained frames and concurrent out-of-order replies', async t => {
  const f = fixture(t);
  const promises = ['first', 'second', 'third'].map(operation => f.client.call(operation, {}));
  const requests = [await f.next(), await f.next(), await f.next()];
  const expected = [
    { text: 'é中👩🏽‍💻\n\u2028\u2029\u0000', _pi_delivery: { receipts: ['known', 'unknown'], digest: 'exact-proof' } },
    { text: 'x'.repeat(500), values: [null, false, { exact: 'e\u0301' }] },
    { text: 'y'.repeat(500) },
  ];
  const first = frame(requests[0], expected[0]);
  const split = first.indexOf(Buffer.from('👩')) + 1;
  const chained = Buffer.concat([frame(requests[2], expected[2]), frame(requests[1], expected[1])]);
  assert.ok(chained.length > 1024, 'limit is per frame, not per stdout chunk');
  f.child.stdout.emit('data', first.subarray(0, split));
  f.child.stdout.emit('data', Buffer.concat([first.subarray(split), chained.subarray(0, -7)]));
  f.child.stdout.emit('data', chained.subarray(-7));
  assert.deepEqual(await Promise.all(promises), expected);
  assert.deepEqual(f.requests, [], 'claimed delivery must not be released');
});

test('the response byte limit includes LF and rejects an unfinished oversized frame for every pending RPC', async t => {
  const f = fixture(t), limit = 1024;
  const allowed = f.client.call('allowed', {}), request = await f.next();
  const expected = { text: '中🙂' };
  expected.text += 'x'.repeat(limit - frame(request, expected).length);
  const legal = frame(request, expected);
  assert.equal(legal.length, limit);
  f.child.stdout.emit('data', legal.subarray(0, -1));
  f.child.stdout.emit('data', legal.subarray(-1));
  assert.deepEqual(await allowed, expected);

  const oversized = f.client.call('oversized', {}), other = f.client.call('other', {});
  const largeRequest = await f.next(); await f.next();
  const rejected = [oversized, other].map(promise => assert.rejects(promise, /Subagent response exceeds frame limit/));
  const result = { text: '' };
  result.text = 'x'.repeat(limit + 1 - frame(largeRequest, result).length);
  const large = frame(largeRequest, result);
  f.child.stdout.emit('data', large.subarray(0, 256));
  f.child.stdout.emit('data', large.subarray(256, -1));
  await Promise.all(rejected);
  f.child.stdout.emit('data', large.subarray(-1));
  await assert.rejects(f.client.call('after-failure', {}), /frontend closed/);
});
