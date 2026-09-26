import test from "node:test";
import assert from "node:assert/strict";
import { styleToolOutputLine } from "../../src/output-style.ts";
import { makeSurfaceOps } from "../../src/surface.ts";

const level = { kind: "truecolor" } as const;
const bg = "\x1b[48;2;31;31;31m";
const surface = makeSurfaceOps(level, (text) => text, (text) => text);

test("composer background follows the last reset/color command, never a color parameter", () => {
  for (const params of ["38;2;10;20;30;0", "38;5;7;49", "48;2;10;20;30;0", "48:2::10:20:30;49"]) {
    const code = `\x1b[${params}m`;
    assert.equal(surface.paintRow(`${code}x`, 1), `${bg}${code}${bg}x\x1b[49m`, params);
  }
  for (const params of ["0;48;2;0;49;22", "48:2::0:49:22", "38;2;0;49;22"]) {
    const code = `\x1b[${params}m`;
    assert.equal(surface.paintRow(`${code}x`, 1), `${bg}${code}x\x1b[49m`, params);
  }
});

test("output dimming consumes exactly the color arguments and then processes intensity in order", () => {
  const dim = (text: string) => styleToolOutputLine(text, { dim: true, colorLevel: level });
  for (const params of ["1;38;2;10;20;30;22", "1;38;5;7;0", "1;38:2::10:20:30;22"]) {
    const code = `\x1b[${params}m`;
    assert.equal(dim(`${code}x`), `\x1b[2m${code}\x1b[2mx\x1b[22m`, params);
  }
  for (const params of ["0;1", "22;3", "38;2;0;22;39;1"]) {
    const code = `\x1b[${params}m`;
    assert.equal(dim(`${code}x`), `\x1b[2m${code}x\x1b[22m`, params);
  }
  assert.equal(dim("\x1b[2J\x1b]8;;url\x07x"), "\x1b[2m\x1b[2J\x1b]8;;url\x07x\x1b[22m");
  const colored = "\x1b[31mred\x1b[0m";
  assert.equal(styleToolOutputLine(colored, { dim: true, colorLevel: { kind: "none" } }), colored);
  assert.equal(styleToolOutputLine("plain", { dim: false, colorLevel: level }), "plain");
});
