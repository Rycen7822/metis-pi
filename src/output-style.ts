// SGR state machine for tool-output dimming (Codex Modifier::DIM semantics).
// A stateless "wrap the whole line in \x1b[2m…\x1b[22m" is NOT equivalent: any
// reset inside the source (0m, empty m, 22m, a later 39m …) would clear our
// DIM for the remainder. This module re-issues DIM after every SGR that could
// have cleared it, and never misreads SGR *parameters* as commands
// (38;2;0;22;39m — the 0/22/39 are RGB components, not resets).

import { DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";

export interface OutputDimPolicy {
  readonly dim: boolean;
  readonly colorLevel: ColorLevel;
}

/**
 * Re-emit DIM after intensity-clearing resets inside `segment`.
 * `dim` false returns the input unchanged (policy off).
 *
 * Single pass: extended-color prefixes 38/48/58 consume their arguments so
 * component values like 0/22/39 can never read as resets; after a clearing
 * sequence (0 / empty / 22 / 21) DIM is re-asserted unless the same sequence
 * set a stronger intensity, and after non-clearing SGRs it is re-asserted
 * conservatively (harmless in real terminals, survives emulators that treat
 * any SGR as a fresh attribute list).
 */
export function reapplyDimAfterResets(segment: string): string {
  if (!segment.includes("\x1b")) return segment;
  let out = "";
  let index = 0;
  while (index < segment.length) {
    const char = segment[index]!;
    if (char === "\x1b" && segment[index + 1] === "[") {
      const match = /^\x1b\[([0-9;:]*)([a-zA-Z])/.exec(segment.slice(index));
      if (match && match[2] === "m") {
        const raw = match[1] ?? "";
        const colon = raw.includes(":");
        const parts = raw === "" ? [] : raw.split(";");
        const hasEmpty = raw === "" || parts.some((p) => p === "");
        const numeric = parts.map((p) => Number.parseInt(p, 10)).filter((p) => Number.isFinite(p)) as number[];
        // Parameter walk honoring extended-color argument consumption.
        let clear = hasEmpty && !colon;
        let setsStrong = false;
        for (let i = 0; i < numeric.length && !clear; i++) {
          const p = numeric[i]!;
          if (p === 38 || p === 48 || p === 58) {
            const mode = numeric[i + 1];
            if (mode === 2) i += 5;
            else if (mode === 5) i += 3;
            else i += 1;
          } else if (p === 0 || p === 21 || p === 22) {
            clear = true;
          } else if (p === 1 || p === 3 || p === 5 || p === 6 || p === 8) {
            setsStrong = true;
          }
        }
        if (clear) {
          out += match[0];
          // A full reset also ends source bold; re-establish our DIM unless
          // this same sequence set a stronger intensity.
          if (!setsStrong) out += DIM_ON;
          index += match[0].length;
          continue;
        }
        // Non-clearing SGR: re-assert DIM after color sequences so our dim
        // survives attribute-list resets in stricter emulators.
        out += match[0];
        if (numeric.length > 0 && !setsStrong) out += DIM_ON;
        index += match[0].length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Style one physical output line. The body keeps its source colors and gains
 * our DIM; line start rebuilds DIM (source state does not leak in), line end
 * restores normal intensity (our DIM never leaks out). Reapplication over an
 * already-styled line does not stack darkness: the trailing INTENSITY_RESET
 * is preserved verbatim and leading DIM_ON is not duplicated.
 */
export function styleToolOutputLine(safeAnsiText: string, policy: OutputDimPolicy): string {
  if (!policy.dim || policy.colorLevel.kind === "none") return safeAnsiText;
  return `${DIM_ON}${reapplyDimAfterResets(safeAnsiText)}${INTENSITY_RESET}`;
}
