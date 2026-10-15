import test from "node:test";
import assert from "node:assert/strict";
import { createSourceSnapshotter } from "../../src/condense/source-snapshot.ts";

test("source snapshots match equal history independent of object identity", () => {
  const capture = createSourceSnapshotter();
  const source = [{ role: "toolResult", content: [{ type: "text", text: "Long evidence. ".repeat(10000) }],
    details: { status: "complete", output: "Original diagnostics. ".repeat(10000) } }];
  assert.equal(capture(source), capture(JSON.parse(JSON.stringify(source))));
});

test("source snapshots detect in-place content and metadata changes and recognize restored evidence", () => {
  const capture = createSourceSnapshotter();
  const source = [{ content: [{ text: "original" }], details: { status: "complete" } }];
  const original = capture(source);
  source[0]!.content[0]!.text = "corrected";
  assert.notEqual(capture(source), original);
  source[0]!.content[0]!.text = "original";
  source[0]!.details.status = "incomplete";
  assert.notEqual(capture(source), original);
  source[0]!.details.status = "complete";
  assert.equal(capture(source), original);
});

test("source snapshots preserve JSON equality, normalization and value-type distinctions", () => {
  const capture = createSourceSnapshotter();
  const pairs: [unknown, unknown][] = [
    ["first string", "0"], ["0", 0], ["0", ["0"]], ["0", { value: "0" }],
    [{ a: undefined, b: NaN }, { b: null }], [[undefined, NaN], [null, null]],
    [{ a: 1, b: "two" }, { b: "two", a: 1 }],
    [new String("0"), "0"],
    [Object.assign(new String("internal"), { toString: () => "visible" }), "visible"],
    [new Date("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z"],
    [{ toJSON: () => "normalized" }, "normalized"],
  ];
  const rawJSON = (JSON as typeof JSON & { rawJSON?: (text: string) => unknown }).rawJSON;
  if (rawJSON) pairs.push(
    [rawJSON('"0"'), "first string"], [rawJSON('"0"'), "0"],
    [rawJSON('"\\u0030"'), "0"],
    [rawJSON("9007199254740993"), rawJSON("9007199254740992")],
  );
  for (const [before, after] of pairs) {
    assert.equal(capture(before) === capture(after), JSON.stringify(before) === JSON.stringify(after));
  }
  assert.throws(() => capture([1n]), TypeError);
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => capture(cycle), TypeError);
});
