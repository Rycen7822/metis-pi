// skill-mux — pi extension entry. Lets one input carry MULTIPLE leading
// skill tokens: `/skill:a /skill:b the rest…` or `￥a ￥b the rest…` (both
// triggers may mix) expands every skill (host-format blocks) plus the
// trailing text. Single `/skill:` inputs, bare `￥`-less text, and everything
// else pass through untouched for the host's native handling.
// See src/skill-mux.ts for the mechanics and performance notes.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSkillAutocompleteWrapper, createSkillMux } from "../src/skill-mux.ts";

export default function skillMuxExtension(pi: ExtensionAPI): void {
  const mux = createSkillMux();
  pi.on("input", (event) => mux.onInput(event));
  pi.on("session_start", (_event, ctx) => {
    // Fill the completion gap the host leaves: second-and-later skill tokens
    // (`/skill:a /…`, `￥…`) get the same skill menu the first token gets.
    // (ctx.ui is the mode-specific UI context; see the host's
    // examples/extensions/github-issue-autocomplete.ts for this pattern.)
    ctx.ui.addAutocompleteProvider(createSkillAutocompleteWrapper(() => mux.listSkills()));
  });
}
