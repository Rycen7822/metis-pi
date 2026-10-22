// Install before transcript components (including replayed entries) are built.
// The SDK import aliases the live host class; this factory owns the leases and
// releases them on shutdown so reload/removal restores native behavior.
import { SkillInvocationMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSkillLabelNames } from "../src/skills/label.ts";

export default function installSkillEntry(pi: ExtensionAPI): void {
  const labels = installSkillLabelNames(SkillInvocationMessageComponent);
  pi.on("session_shutdown", () => labels.release());
}
