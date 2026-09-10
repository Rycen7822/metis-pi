
import test from "node:test";
import assert from "node:assert/strict";
import { parseDisplayDiff } from "../src/diff.ts";

test("parser invariants: digits and indentation in content are never eaten", () => {
  // "+ 10 123 value" => number=10, content="123 value"
  const a = parseDisplayDiff("+ 10 123 value");
  assert.equal(a.length, 1);
  assert.equal(a[0].newNumber, 10);
  assert.equal(a[0].content, "123 value");

  // "+ 10   return x" => number=10, content="  return x" (indent preserved)
  const b = parseDisplayDiff("+ 10   return x");
  assert.equal(b.length, 1);
  assert.equal(b[0].newNumber, 10);
  assert.equal(b[0].content, "  return x");

  // Empty content, trailing whitespace, CJK, emoji survive verbatim.
  const c = parseDisplayDiff("- 7 ");
  assert.equal(c[0].oldNumber, 7);
  assert.equal(c[0].content, "");
  const d = parseDisplayDiff("+ 8 \u4e2d\u6587 \ud83d\ude80  ");
  assert.equal(d[0].content, "\u4e2d\u6587 \ud83d\ude80  ");

  // Context rows carry a single number; a digit-leading remainder stays
  // content — the parser never guesses a second line number.
  const e = parseDisplayDiff("  12 13 shared");
  assert.equal(e[0].newNumber, 12);
  assert.equal(e[0].content, "13 shared");
});
