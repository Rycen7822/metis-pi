import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { TokenEstimator } from "../../src/condense/token-estimator.ts";

const messages = content => [{ role: "user", content, timestamp: 1 }];

function fixture(t) {
  const estimator = new TokenEstimator();
  const workers = new Set();
  const retirements = new Map();
  const postMessage = Worker.prototype.postMessage;
  const terminate = Worker.prototype.terminate;
  t.mock.method(Worker.prototype, "postMessage", function (...args) {
    if (Array.isArray(args[0]?.before) && Array.isArray(args[0]?.after)) workers.add(this);
    return Reflect.apply(postMessage, this, args);
  });
  t.mock.method(Worker.prototype, "terminate", function (...args) {
    const retired = Reflect.apply(terminate, this, args);
    retirements.set(this, retired);
    return retired;
  });
  t.after(async () => {
    estimator.clear();
    await Promise.all(retirements.values());
    assert.ok([...workers].every(worker => worker.threadId === -1), "all owned encoders must exit");
  });
  return { estimator, workers, retirements };
}

test("idle encoder retires without discarding counts or being kept alive by cache lookups", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { estimator, workers, retirements } = fixture(t);
  const input = messages("Stable evidence for an exact token count.");
  const first = await estimator.measure(input, []);
  assert.ok(first && first.before > 0);
  assert.equal(workers.size, 1);
  const [worker] = workers;

  t.mock.timers.tick(50_000);
  assert.deepEqual(await estimator.measure(input, []), first);
  assert.equal(retirements.size, 0, "short idle pauses keep the encoder warm");
  t.mock.timers.tick(10_000);
  assert.ok(retirements.has(worker), "one minute without actual encoding must retire the worker");
  await retirements.get(worker);
  assert.equal(worker.threadId, -1);

  assert.deepEqual(await estimator.measure(input, []), first);
  assert.equal(workers.size, 1, "cached counts do not restart an idle worker");
  const next = await estimator.measure(messages("Different evidence starts the encoder again."), []);
  assert.ok(next && next.before > 0);
  assert.equal(workers.size, 2);
  estimator.clear();
  assert.deepEqual(await estimator.measure(input, []), first, "clear permits a clean encoder generation");
});

test("queued token comparisons retain request-time contents and FIFO completion", { timeout: 15_000 }, async t => {
  const { estimator } = fixture(t);
  const queued = messages("Original queued evidence.");
  const expectedInput = structuredClone(queued);
  const completion = [];
  const first = estimator.measure(messages("Keep the initial encoder busy."), []).then(value => {
    completion.push("first");
    return value;
  });
  const second = estimator.measure(queued, []).then(value => {
    completion.push("second");
    return value;
  });
  queued[0].content = "Changed after enqueue. ".repeat(500);
  const [one, two] = await Promise.all([first, second]);
  assert.ok(one && two);
  assert.deepEqual(completion, ["first", "second"]);
  estimator.clear();
  assert.deepEqual(two, await estimator.measure(expectedInput, []), "queueing snapshots before caller mutation");
});

test("abort settles queued jobs and a retiring encoder cannot clear the replacement", { timeout: 15_000 }, async t => {
  const { estimator, workers, retirements } = fixture(t);
  const controller = new AbortController();
  const first = estimator.measure(messages("Cancelled work."), [], controller.signal);
  const queued = estimator.measure(messages("Queued cancellation."), []);
  controller.abort();
  assert.deepEqual(await Promise.all([first, queued]), [null, null]);
  const replacement = messages("New generation survives the previous worker's exit.");
  const expected = structuredClone(replacement);
  const next = estimator.measure(replacement, []);
  replacement[0].content = "Changed while the previous encoder terminates.";
  const result = await next;
  assert.ok(result && result.before > 0);
  estimator.clear();
  assert.deepEqual(result, await estimator.measure(expected, []));
  await Promise.all(retirements.values());
  assert.equal([...workers].filter(worker => worker.threadId !== -1).length, 1);
});
