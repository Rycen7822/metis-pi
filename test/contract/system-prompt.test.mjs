import test from "node:test";
import assert from "node:assert/strict";
import systemPrompt from "../../extensions/system-prompt.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

function fixture(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporaryDirectory(t, "metis-prompt-");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  let before;
  systemPrompt({ on(name, handler) { assert.equal(name, "before_agent_start"); before = handler; } });
  return (overrides = {}) => {
    const options = { selectedTools: ["read", "codemode"], sections: { unrelated: "keep" }, ...overrides };
    before({ systemPromptOptions: options });
    return options;
  };
}

test("codemode workflow guidance preserves other sections and does not accumulate on repeated preparation", t => {
  const prepare = fixture(t), first = prepare();
  assert.equal(first.sections.unrelated, "keep");
  assert.match(first.sections.metis_codemode, /model.*judgment/i);
  assert.match(first.sections.metis_codemode, /errors|failures/i);
  assert.match(first.sections.metis_codemode, /truncat|incomplete/i);
  assert.match(first.sections.metis_codemode, /unknown/i);
  assert.deepEqual(prepare({ sections: { ...first.sections } }).sections, first.sections);
});

test("disabling codemode removes only its stale guidance and keeps documentation", t => {
  const prepare = fixture(t);
  const options = prepare({ selectedTools: ["read"], sections: { unrelated: "keep", metis_codemode: "stale" } });
  assert.equal(options.sections.metis_codemode, undefined);
  assert.equal(options.sections.unrelated, "keep");
  assert.match(options.sections.docs, /PI_Documentation_Guide/);
});

for (const override of [{ customPrompt: "custom" }, { forceSystemPrompt: "" }]) {
  test(`explicit system prompt override is respected: ${Object.keys(override)[0]}`, t => {
    const prepare = fixture(t), sections = { unrelated: "keep" };
    assert.deepEqual(prepare({ ...override, sections }).sections, { unrelated: "keep" });
  });
}
