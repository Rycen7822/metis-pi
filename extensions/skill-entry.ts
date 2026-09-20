// skill-entry — pi extension entry for both patches of the host's folded
// `[skill] …` transcript entry:
//   1. clickable fold — a left click expands it, another collapses it
//      (keyboard ctrl+o keeps working unchanged); see src/skill-fold.ts.
//   2. full name label — a multi-skill invocation from skill-mux reads
//      `[skill] a + b (hint)` and the expanded header lists them too; see
//      src/skill-label.ts.
// They are one entry file because they patch the SAME host class at the same
// moment and share one load-time install path.

import * as Pi from "@earendil-works/pi-coding-agent";
import { installSkillFoldClick } from "../src/skill-fold.ts";
import { installSkillLabelNames } from "../src/skill-label.ts";

// Module scope on purpose: extensions load before the interactive mode builds
// any transcript component, and both patches are prototype methods, so every
// skill entry created later (including replayed history) is covered. The
// extension loader aliases `@earendil-works/pi-coding-agent` onto the host's
// own module instance, so this class IS the one the live session instantiates.
const skillComponent = (Pi as { SkillInvocationMessageComponent?: unknown }).SkillInvocationMessageComponent;
installSkillFoldClick(skillComponent);
installSkillLabelNames(skillComponent);

export default function skillEntryExtension(): void {
  // Installed at import time; nothing to register per session.
}
