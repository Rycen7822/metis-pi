// skill-fold — pi extension entry. Makes the host's folded `[skill] …` entries
// clickable: a left click on the entry expands it, another click collapses it
// (keyboard ctrl+o keeps working unchanged).
// See src/skill-fold.ts for the mechanism and the gesture contract.

import * as Pi from "@earendil-works/pi-coding-agent";
import { installSkillFoldClick, type SkillFoldInstall } from "../src/skill-fold.ts";

// Module scope on purpose: extensions load before the interactive mode builds
// any transcript component, and the patch is a prototype method, so every skill
// entry created later (including replayed history) is clickable. The extension
// loader aliases `@earendil-works/pi-coding-agent` onto the host's own module
// instance, so this class IS the one the live session instantiates.
export const skillFoldInstall: SkillFoldInstall = installSkillFoldClick(
  (Pi as { SkillInvocationMessageComponent?: unknown }).SkillInvocationMessageComponent,
);

export default function skillFoldExtension(): void {
  // Installed at import time; nothing to register per session.
}
