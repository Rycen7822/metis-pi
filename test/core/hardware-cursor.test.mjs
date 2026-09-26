import test from "node:test";
import assert from "node:assert/strict";
import { createHardwareCursor } from "../../src/chrome/hardware-cursor.ts";

function renderer(initial = false) {
  const writes = [];
  let visible = initial;
  return {
    writes,
    terminal: { write(text) { writes.push(text); } },
    getShowHardwareCursor() { return visible; },
    setShowHardwareCursor(next) { visible = next; },
  };
}

test("hardware cursor lease restores visibility and terminal shape on release and renderer change", () => {
  const cursor = createHardwareCursor();
  const first = renderer();
  const isFirstActive = cursor.acquire(first);
  assert.equal(isFirstActive(), true);
  assert.deepEqual(first.writes, ["\x1b[6 q"]);
  assert.equal(cursor.acquire(first)(), true, "idempotent on the same renderer");
  assert.deepEqual(first.writes, ["\x1b[6 q"]);
  const next = renderer(true);
  const isNextActive = cursor.acquire(next);
  assert.equal(isFirstActive(), false, "old editor no longer suppresses native cursor");
  assert.equal(first.getShowHardwareCursor(), false);
  assert.equal(first.writes.at(-1), "\x1b[0 q");
  assert.equal(isNextActive(), true);
  next.setShowHardwareCursor(false); // host settings override: do not hide all cursors
  assert.equal(isNextActive(), false);
  cursor.release();
  assert.equal(next.getShowHardwareCursor(), false);
  assert.equal(next.writes.at(-1), "\x1b[0 q");
  cursor.release();
  assert.equal(next.writes.length, 2, "cleanup is idempotent");

  const alreadyVisible = renderer(true);
  const active = cursor.acquire(alreadyVisible);
  assert.equal(active(), true);
  assert.equal(cursor.acquire({ terminal: {} }), undefined, "unsupported successor releases prior lease");
  assert.equal(active(), false);
  assert.equal(alreadyVisible.getShowHardwareCursor(), true, "originally enabled cursor stays enabled");
  assert.equal(alreadyVisible.writes.at(-1), "\x1b[0 q");
});

test("hardware cursor acquisition failure and absent APIs leave the native block available", () => {
  const cursor = createHardwareCursor();
  assert.equal(cursor.acquire({ terminal: {} }), undefined);
  const bad = renderer();
  bad.setShowHardwareCursor = () => { throw new Error("host unavailable"); };
  assert.equal(cursor.acquire(bad), undefined);
  assert.deepEqual(bad.writes, ["\x1b[6 q", "\x1b[0 q"], "no leaked terminal cursor shape");
  const good = renderer();
  assert.equal(cursor.acquire(good)(), true, "a failed install must not poison a later one");
  cursor.release();
  assert.equal(good.getShowHardwareCursor(), false);
});
