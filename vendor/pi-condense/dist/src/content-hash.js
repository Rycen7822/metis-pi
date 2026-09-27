/** Exact body identity only; execution identity remains on each occurrence. */
import { createHash } from "node:crypto";
export function hashToolResult(toolName, resultText) {
    // A version prefix keeps old whitespace-normalized hashes from becoming exact matches.
    return `exact-v1:${createHash("sha256").update(toolName).update("\0").update(resultText).digest("hex")}`;
}
