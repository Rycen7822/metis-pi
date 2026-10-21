import test from "node:test";
import assert from "node:assert/strict";
import { createHardwareCursor } from "../../src/appearance/chrome/hardware-cursor.ts";

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
  cursor.acquire(first);
  assert.equal(first.getShowHardwareCursor(), true);
  assert.deepEqual(first.writes, ["\x1b[6 q"]);
  cursor.acquire(first);
  assert.equal(first.getShowHardwareCursor(), true, "idempotent on the same renderer");
  assert.deepEqual(first.writes, ["\x1b[6 q"]);
  const next = renderer(true);
  cursor.acquire(next);
  assert.equal(first.getShowHardwareCursor(), false);
  assert.equal(first.writes.at(-1), "\x1b[0 q");
  assert.equal(next.getShowHardwareCursor(), true);
  next.setShowHardwareCursor(false);
  cursor.release();
  assert.equal(next.getShowHardwareCursor(), false);
  assert.equal(next.writes.at(-1), "\x1b[0 q");
  cursor.release();
  assert.equal(next.writes.length, 2, "cleanup is idempotent");

  const alreadyVisible = renderer(true);
  cursor.acquire(alreadyVisible);
  assert.equal(alreadyVisible.getShowHardwareCursor(), true);
  cursor.acquire({ terminal: {} });
  assert.equal(alreadyVisible.getShowHardwareCursor(), true, "originally enabled cursor stays enabled");
  assert.equal(alreadyVisible.writes.at(-1), "\x1b[0 q");
});

test("hardware cursor acquisition failure and absent APIs leave the native block available", () => {
  const cursor = createHardwareCursor();
  cursor.acquire({ terminal: {} });
  const bad = renderer();
  bad.setShowHardwareCursor = () => { throw new Error("host unavailable"); };
  cursor.acquire(bad);
  assert.deepEqual(bad.writes, ["\x1b[6 q", "\x1b[0 q"], "no leaked terminal cursor shape");
  const good = renderer();
  cursor.acquire(good);
  assert.equal(good.getShowHardwareCursor(), true, "a failed install must not poison a later one");
  cursor.release();
  assert.equal(good.getShowHardwareCursor(), false);
});
