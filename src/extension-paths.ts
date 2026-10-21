// Physical entry identities, not authorization policy. Consumers keep their own gates.
import { fileURLToPath } from "node:url";

export const OWNED_EXECUTION_ENTRY = fileURLToPath(new URL("../extensions/execution.ts", import.meta.url));
export const OWNED_FUSION_ENTRY = fileURLToPath(new URL("../extensions/action-fusion.ts", import.meta.url));
export const OWNED_NEURAL_SEARCH_ENTRY = fileURLToPath(new URL("../extensions/neural-search.ts", import.meta.url));
