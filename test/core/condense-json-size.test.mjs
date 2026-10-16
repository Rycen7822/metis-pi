import test from "node:test";
import assert from "node:assert/strict";
import { createJsonSizeMeasurer } from "../../src/condense/json-size.ts";

const text = 'quotes " and slash \\ newline\n\u0000 中文 😀 \ud800'.repeat(300);
const cases = [
  text,
  { repeated: text, again: text, small: "ok", omitted: undefined },
  [text, null, undefined, NaN, Infinity, -0, true],
  { nested: [{ toJSON: () => ({ text }) }], date: new Date("2026-01-01T00:00:00Z") },
  { boxed: new String(text) },
  ...(typeof JSON.rawJSON === "function" ? [{ raw: JSON.rawJSON("123"), text }] : []),
];
for (let i = 0; i < cases.length; i++) test(`cached JSON size stays exact, cold and warm: ${i}`, () => {
  const sizes = createJsonSizeMeasurer();
  const expected = JSON.stringify(cases[i]).length;
  assert.equal(sizes.measure(cases[i]), expected);
  assert.equal(sizes.measure(cases[i]), expected);
});

test("JSON size follows same-object edits and keeps native serialization failures", () => {
  const sizes = createJsonSizeMeasurer();
  const value = { content: "x".repeat(5000) };
  sizes.measure(value);
  value.content = "\\".repeat(5000);
  assert.equal(sizes.measure(value), JSON.stringify(value).length);
  for (const invalid of [undefined, { bigint: 1n }, (() => { const x = {}; x.self = x; return x; })()]) {
    assert.throws(() => sizes.measure(invalid), TypeError);
  }
});

test("JSON size cache is bounded and keeps the stable prefix instead of thrashing", t => {
  const sizes = createJsonSizeMeasurer();
  const values = Array.from({ length: 4096 }, (_, i) => `${i}:` + "x".repeat(4096));
  const stringify = JSON.stringify;
  let firstEncodings = 0;
  t.mock.method(JSON, "stringify", (value, ...args) => {
    if (value === values[0]) firstEncodings++;
    return stringify(value, ...args);
  });
  assert.equal(sizes.full, false);
  const value = { values };
  assert.equal(sizes.measure(value), JSON.stringify(value).length);
  assert.equal(sizes.full, true);
  const overflow = { content: "outside the prefix".repeat(300) };
  assert.equal(sizes.measure(overflow), JSON.stringify(overflow).length);
  assert.equal(sizes.measure(value), JSON.stringify(value).length);
  assert.equal(firstEncodings, 1, "overflow must not evict and re-encode the stable prefix");
  sizes.clear();
  assert.equal(sizes.full, false);
});

test("clearing JSON sizes releases cached long-string encodings", t => {
  const sizes = createJsonSizeMeasurer(), payload = "cache me".repeat(700);
  const stringify = JSON.stringify;
  let encodings = 0;
  t.mock.method(JSON, "stringify", (value, ...args) => {
    if (value === payload) encodings++;
    return stringify(value, ...args);
  });
  sizes.measure({ payload });
  sizes.measure({ payload });
  assert.equal(encodings, 1);
  sizes.clear();
  sizes.measure({ payload });
  assert.equal(encodings, 2);
});
