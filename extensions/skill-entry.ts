// Install before transcript components (including replayed entries) are built.
// The SDK import aliases the live host class; this factory owns the leases and
// releases them on shutdown so reload/removal restores native behavior.
import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSkillFoldClick } from "../src/skills/fold.ts";
import { installSkillLabelNames } from "../src/skills/label.ts";

export default function installSkillEntry(pi: ExtensionAPI): void {
  const component = (Pi as { SkillInvocationMessageComponent?: unknown }).SkillInvocationMessageComponent;
  const leases = [installSkillFoldClick(component), installSkillLabelNames(component)];
  pi.on("session_shutdown", () => {
    for (const lease of leases) lease.release();
  });
}
