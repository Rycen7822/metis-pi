import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/subagents/core/runtime/task-queue.mjs';
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('one owner serializes continuations and completes once after all of them', async () => {
  const done = gate(), block = gate(), started = gate(), seen = [], terminal = [];
  const queue = new TaskQueue(async input => {
    seen.push(input);
    if (input === 'root') { queue.enqueue('one'); queue.enqueue('two'); started.resolve(); await block.promise; }
    if (input === 'one') queue.enqueue('three');
    queue.observe({ type: 'message_end', message: { role: 'assistant' } });
  }, event => { terminal.push(event); done.resolve(); });
  queue.start('a', 'root');
  await started.promise;
  assert.throws(() => queue.start('b', 'intruder'), /already active/);
  assert.deepEqual(seen, ['root']);
  assert.equal(terminal.length, 0);
  block.resolve(); await done.promise;
  assert.deepEqual(seen, ['root', 'one', 'two', 'three']);
  assert.deepEqual(terminal, [{ type: 'managed_task_end', runId: 'a', error: undefined }]);
});

test('callbacks from a completed owner cannot join the next task', async () => {
  const first = gate(), second = gate(), block = gate(), attempted = gate();
  let stale;
  const seen = [];
  const queue = new TaskQueue(async input => {
    seen.push(input);
    if (input === 'first') {
      const owner = queue.context.getStore();
      stale = () => queue.context.run(owner, () => queue.enqueue('stale'));
    } else { attempted.resolve(); await block.promise; }
    queue.observe({ type: 'message_end', message: { role: 'assistant' } });
  }, event => (event.runId === 'a' ? first : second).resolve());
  queue.start('a', 'first'); await first.promise;
  queue.start('b', 'second'); await attempted.promise;
  assert.throws(stale, /already ended/);
  block.resolve(); await second.promise;
  assert.deepEqual(seen, ['first', 'second']);
});

test('handled input completes visibly as failure without waiting for a host event', async () => {
  const done = gate();
  const queue = new TaskQueue(async () => {}, done.resolve);
  queue.start('handled', 'text');
  const result = await done.promise;
  assert.match(result.error, /without producing/);
  assert.equal(result.runId, 'handled');
});

test('SDK rejection discards its queued continuations and releases the owner', async () => {
  const done = gate(); const seen = [];
  const queue = new TaskQueue(async input => {
    seen.push(input); queue.enqueue('must not execute'); throw new Error('SDK failed');
  }, done.resolve);
  queue.start('failure', 'first');
  assert.match((await done.promise).error, /SDK failed/);
  assert.deepEqual(seen, ['first']); assert.equal(queue.active, undefined);
});

test('accepted extension inputs have both count and byte limits', async () => {
  async function blockedQueue() {
    const started = gate(), release = gate(), done = gate();
    const queue = new TaskQueue(async input => {
      if (input === 'root') { started.resolve(); await release.promise; }
    }, done.resolve);
    queue.start('owner', 'root'); await started.promise;
    return { queue, release, done };
  }
  const count = await blockedQueue();
  count.queue.context.run(count.queue.active, () => {
    for (let i = 0; i < 256; i++) count.queue.enqueue('x');
    assert.throws(() => count.queue.enqueue('extra'), /capacity/);
  });
  count.release.resolve(); await count.done.promise;
  assert.equal(count.queue.active, undefined);

  const bytes = await blockedQueue();
  bytes.queue.context.run(bytes.queue.active, () => {
    const chunk = 'x'.repeat(3 * 1024 * 1024);
    bytes.queue.enqueue(chunk); bytes.queue.enqueue(chunk);
    assert.throws(() => bytes.queue.enqueue(chunk), /capacity/);
  });
  bytes.release.resolve(); await bytes.done.promise;
  assert.equal(bytes.queue.active, undefined);
});


test('abort returning idle does not release a blocked SDK preflight', async () => {
  const started=gate(), release=gate(), ended=gate();
  const queue=new TaskQueue(async () => { started.resolve(); await release.promise; }, ended.resolve);
  queue.start('old','blocked'); await started.promise;
  let completed=false; const canceled=queue.cancel(async () => {}).then(x => { completed=true; return x; });
  await Promise.resolve(); assert.equal(completed,false);
  assert.throws(() => queue.start('new','next'),/already active/);
  assert.throws(() => queue.enqueue('late',queue.active),/cancelled/);
  release.resolve(); const result=await canceled;
  assert.deepEqual(result,{runId:'old',taskExited:true}); assert.equal((await ended.promise).cancelled,true);
});

test('cancel waits for a native input preflight and discards later controls', async () => {
  const root=gate(), native=gate(), entered=gate(), done=gate(); let calls=0;
  const queue=new TaskQueue(async () => { await root.promise; },event => {
    if (event.type === 'managed_task_end') done.resolve(event);
  });
  queue.start('a','root');
  queue.native('first',async () => { calls++; entered.resolve(); await native.promise; });
  queue.native('second',async () => { calls++; });
  await entered.promise;
  const stopped=queue.cancel(async () => {}); root.resolve(); await Promise.resolve();
  assert.ok(queue.active); native.resolve(); await stopped;
  assert.equal(calls,1); assert.equal((await done.promise).cancelled,true);
});

test('native preflight drains before the next serialized SDK call starts', async () => {
  const root=gate(), native=gate(), entered=gate(), done=gate(); const calls=[];
  const queue=new TaskQueue(async input => { calls.push(input); if (input==='root') await root.promise;
    queue.observe({type:'message_end',message:{role:'assistant'}}); },event => {
    if (event.type==='managed_task_end') done.resolve(event);
  });
  queue.start('a','root'); queue.enqueue('legacy',queue.active);
  queue.native('native',async () => { entered.resolve(); await native.promise; calls.push('native'); });
  await entered.promise; root.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls,['root']); native.resolve(); await done.promise;
  assert.deepEqual(calls,['root','native','legacy']);
});
