// SGR state machine for tool-output dimming (Codex Modifier::DIM semantics).
// A stateless "wrap the whole line in \x1b[2m…\x1b[22m" is NOT equivalent: any
// reset inside the source (0m, empty m, 22m, a later 39m …) would clear our
// DIM for the remainder. This module re-issues DIM after every SGR that could
// have cleared it, and never misreads SGR *parameters* as commands
// (38;2;0;22;39m — the 0/22/39 are RGB components, not resets).

import { appendAfterSgr } from "./sgr.ts";
import { DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";

export interface OutputDimPolicy {
  readonly dim: boolean;
  readonly colorLevel: ColorLevel;
}

/** Reapply DIM unless the sequence ends with an explicitly stronger style. */
export function reapplyDimAfterResets(segment: string): string {
  return appendAfterSgr(segment, (commands) => {
    let strong = false;
    for (const code of commands) {
      if (code === 0 || code === 21 || code === 22) strong = false;
      else if (code === 1 || code === 3 || code === 5 || code === 6 || code === 8) strong = true;
    }
    return commands.length && !strong ? DIM_ON : "";
  });
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
