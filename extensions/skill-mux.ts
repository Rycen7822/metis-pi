// skill-mux — pi extension entry. Lets one input carry MULTIPLE leading
// `/skill:name` tokens: `/skill:a /skill:b the rest…` expands every skill
// (host-format blocks) plus the trailing text. Single `/skill:` inputs and
// everything else pass through untouched for the host's native handling.
// See src/skill-mux.ts for the mechanics and performance notes.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSkillMux } from "../src/skill-mux.ts";

export default function skillMuxExtension(pi: ExtensionAPI): void {
  const mux = createSkillMux();
  pi.on("input", (event) => mux.onInput(event));
}
