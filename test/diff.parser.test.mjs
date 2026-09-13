import test from "node:test";
import assert from "node:assert/strict";
import { parseDisplayDiff } from "../src/diff.ts";

test("parser invariants: digits and indentation in content are never eaten", () => {
  const cases = [
    ["+ 10 123 value", "newNumber", 10, "123 value"],
    ["+ 10   return x", "newNumber", 10, "  return x"],
    ["- 7 ", "oldNumber", 7, ""],
    ["+ 8 \u4e2d\u6587 \ud83d\ude80  ", "newNumber", 8, "\u4e2d\u6587 \ud83d\ude80  "],
    ["  12 13 shared", "newNumber", 12, "13 shared"],
  ];
  for (const [source, numberField, number, content] of cases) {
    const rows = parseDisplayDiff(source);
    assert.equal(rows.length, 1, source);
    assert.equal(rows[0][numberField], number, source);
    assert.equal(rows[0].content, content, source);
  }
});
