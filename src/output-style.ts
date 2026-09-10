// SGR state machine for tool-output dimming (Codex Modifier::DIM semantics).
//
// Codex dims result output by parsing the source ANSI into spans and applying
// Modifier::DIM to every span; raw colors survive. A stateless "wrap the whole
// line in \x1b[2m…\x1b[22m" is NOT equivalent: any reset inside the source
// (0m, empty m, 22m, a later 39m after a color, etc.) would clear our DIM for
// the remainder. This module re-issues DIM after every SGR that could have
// cleared it, and never misreads SGR *parameters* as commands
// (38;2;0;22;39m — the 0/22/39 are RGB components, not resets).

import { DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";

export interface OutputDimPolicy {
  readonly dim: boolean;
  readonly colorLevel: ColorLevel;
}

/** SGR parameter groups that clear intensity to normal. */
function clearsIntensity(params: readonly number[], hasEmptyParam: boolean, colonSubParams: boolean): boolean {
  // "\x1b[m" (empty) and "\x1b[0m" / "\x1b[00m" are full resets.
  if (hasEmptyParam) return true;
  if (colonSubParams) return false; // "\x1b[38:2:…m" sub-parameter form — not a reset here.
  if (params.length === 0) return true;
  for (const p of params) {
    if (p === 0 || p === 22) return true; // 22 also ends "bold" — both end DIM per SGR.
    if (p === 21) return true; // doubly-underlined but widely treated as bold-off.
  }
  return false;
}

/** True when any parameter in this SGR sets or preserves non-default intensity other than DIM. */
function setsBold(params: readonly number[]): boolean {
  return params.some((p) => p === 1 || p === 2 || p === 3 || p === 5 || p === 6 || p === 8);
}

/**
 * Re-emit DIM after intensity-clearing resets inside `segment`.
 * `dim` false returns the input unchanged (policy off).
 */
export function reapplyDimAfterResets(segment: string): string {
  let out = "";
  let index = 0;
  let needDim = false; // our DIM is active at the current position?
  while (index < segment.length) {
    const char = segment[index]!;
    if (char === "\x1b" && segment[index + 1] === "[") {
      const match = /^\x1b\[([0-9;:]*)([a-zA-Z])/.exec(segment.slice(index));
      if (match && match[2] === "m") {
        const raw = match[1] ?? "";
        const colon = raw.includes(":");
        const parts = raw === "" ? [] : raw.split(";").map((p) => (p === "" ? NaN : Number.parseInt(p, 10)));
        const hasEmpty = raw === "" || raw.endsWith(";") || raw.split(";").some((p) => p === "");
        const numeric = parts.filter((p) => Number.isFinite(p)) as number[];
        // Parse parameter-by-parameter so compound sequences ("\x1b[1;31m")
        // honor each code's scope; color-set prefixes (38/48/58) consume their
        // arguments so their components can never read as resets.
        let i = 0;
        let clear = hasEmpty;
        while (i < numeric.length && !clear) {
          const p = numeric[i]!;
          if (p === 38 || p === 48 || p === 58) {
            // Extended color: 38;5;N or 38;2;R;G;B — skip arguments.
            const mode = numeric[i + 1];
            if (mode === 2) i += 5;
            else if (mode === 5) i += 3;
            else i += 1; // Malformed: treat the marker alone.
          } else if (p === 0 || p === 21 || p === 22) {
            clear = true;
            break;
          }
          i += 1;
        }
        if (colon) clear = false;
        if (clear) {
          out += segment.slice(index, index + match[0].length);
          // Preserve the source's intent (a reset also ends source bold),
          // then re-establish our DIM unless the source sets new intensity.
          const setsNewIntensity = setsBold(numeric.filter((p) => !(p === 38 || p === 48 || p === 58)) as number[]) && !clear;
          if (!setsNewIntensity) {
            out += DIM_ON;
            needDim = true;
          } else {
            needDim = false;
          }
          index += match[0].length;
          continue;
        }
        // Non-clearing SGR (colors, bold-on…): our DIM persists in terminals
        // that keep attributes across color changes, but conservative output
        // re-asserts DIM after color SGRs to survive emulators that treat any
        // SGR as a fresh attribute list — harmless double-dim.
        if (needDim && numeric.length > 0) out += segment.slice(index, index + match[0].length) + DIM_ON;
        else out += segment.slice(index, index + match[0].length);
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
 * restores normal intensity (our DIM never leaks out).
 */
export function styleToolOutputLine(safeAnsiText: string, policy: OutputDimPolicy): string {
  if (!policy.dim || policy.colorLevel.kind === "none") return safeAnsiText;
  return `${DIM_ON}${reapplyDimAfterResets(safeAnsiText)}${INTENSITY_RESET}`;
}
