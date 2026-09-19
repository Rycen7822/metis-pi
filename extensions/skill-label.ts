// skill-label — pi extension entry. The host's folded skill entry is
// `[skill] <first name> (hint)`; a multi-skill invocation from skill-mux now
// reads `[skill] a + b (hint)` (and the expanded header lists them too).
// See src/skill-label.ts for the mechanism and the surgery rules.

import * as Pi from "@earendil-works/pi-coding-agent";
import { installSkillLabelNames, type SkillLabelInstall } from "../src/skill-label.ts";

// Module scope on purpose (same as skill-fold): extensions load before the
// interactive mode builds any transcript component, and the patch is a prototype
// method, so every entry created later — including replayed history — is
// labelled. The extension loader aliases `@earendil-works/pi-coding-agent` onto
// the host's own module instance, so this class IS the live one.
export const skillLabelInstall: SkillLabelInstall = installSkillLabelNames(
  (Pi as { SkillInvocationMessageComponent?: unknown }).SkillInvocationMessageComponent,
);

export default function skillLabelExtension(): void {
  // Installed at import time; nothing to register per session.
}
