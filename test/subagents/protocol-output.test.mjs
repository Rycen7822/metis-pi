import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProtocolOutput } from '../../src/subagents/core/runtime/protocol-output.mjs';

function fixture(options = {}) {
  const stream = new PassThrough({ highWaterMark: 64 });
  const failures = [], chunks = [];
  const output = createProtocolOutput(stream, { fail: error => failures.push(error), ...options });
  const collect = () => stream.on('data', chunk => chunks.push(chunk));
  const frames = () => Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  return { stream, output, failures, collect, frames };
}
const progress = i => ({ type: 'tool_execution_update', toolCallId: 'tool', result: 'x'.repeat(1024), i });

test('backpressure coalesces progress and preserves critical order and final output', async () => {
  const f = fixture({ maxBytes: 8192 });
  f.output(progress(0));
  for (let i = 1; i <= 2048; i++) f.output(progress(i));
  f.output({ type: 'tool_execution_end', toolCallId: 'tool', result: 'FINAL' });
  f.output({ type: 'message_end', message: { role: 'assistant', content: 'ANSWER' } });
  f.output({ type: 'managed_task_end', runId: 'a' });
  f.output({ type: 'response', id: 'rpc', success: true });
  f.output({ type: 'extension_ui_request', id: 'question', method: 'confirm' });
  f.output({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'new task' } });
  assert.ok(f.stream.writableLength < 8192);
  f.collect(); await sleep(20);
  const frames = f.frames();
  assert.deepEqual(frames.map(e => e.type), ['tool_execution_update','tool_execution_update',
    'tool_execution_end','message_end','managed_task_end','response','extension_ui_request','message_update']);
  assert.equal(frames[1].i, 2048);
  assert.equal(frames[2].result, 'FINAL');
  assert.equal(frames[3].message.content, 'ANSWER');
  assert.equal(frames[4].runId, 'a');
  assert.deepEqual(f.failures, []);
  f.stream.destroy();
});

test('critical overflow fails once, drops buffered frames and does not fake a completion', async () => {
  const f = fixture({ maxBytes: 2048 });
  f.output({ type: 'response', id: 0, text: 'x'.repeat(1200) });
  f.output({ type: 'message_end', text: 'y'.repeat(1200) });
  f.output({ type: 'managed_task_end', runId: 'must-not-report' });
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /capacity/);
  assert.equal(f.stream.listenerCount('drain'), 0);
  f.collect(); await sleep(10);
  assert.deepEqual(f.frames().map(e => e.type), ['response']);
  f.stream.destroy();
});

test('small critical frames also have a bounded pending count', () => {
  const f = fixture();
  f.output(progress(0));
  for (let i = 0; i < 300; i++) f.output({ type: 'response', id: i });
  assert.equal(f.failures.length, 1);
  f.stream.destroy();
});

test('critical output can evict progress, but never another critical frame', async () => {
  const f = fixture({ maxBytes: 3072 });
  f.output(progress(0)); f.output(progress(1));
  f.output({ type: 'managed_task_end', runId: 'a', detail: 'x'.repeat(1500) });
  f.collect(); await sleep(10);
  assert.deepEqual(f.frames().map(e => e.type), ['tool_execution_update','managed_task_end']);
  assert.deepEqual(f.failures, []);
  f.stream.destroy();
});

test('a stalled pipe fails on its output deadline, not a task duration limit', async () => {
  const f = fixture({ timeoutMs: 20 });
  f.output(progress(0));
  await sleep(40);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /stalled/);
  f.stream.destroy();
});

test('drain clears the deadline and a readable channel stays usable', async () => {
  const f = fixture({ timeoutMs: 20 });
  f.output(progress(0)); f.collect();
  await sleep(40);
  f.output({ type: 'managed_task_end', runId: 'complete' });
  await sleep(10);
  assert.deepEqual(f.failures, []);
  assert.equal(f.frames().at(-1).runId, 'complete');
  f.stream.destroy();
});

test('pipe errors stop the channel without uncaught exceptions or later writes', () => {
  const f = fixture();
  f.stream.emit('error', new Error('EPIPE'));
  f.output({ type: 'managed_task_end', runId: 'undelivered' });
  assert.equal(f.failures.length, 1);
  assert.equal(f.stream.writableLength, 0);
  f.stream.destroy();
});
