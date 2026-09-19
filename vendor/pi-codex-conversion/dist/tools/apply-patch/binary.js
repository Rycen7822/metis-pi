import { getBundledToolBinaryPath } from "../native/binary.js";
export function getBundledApplyPatchBinaryPath(customDir) {
    return getBundledToolBinaryPath("apply_patch", {}, customDir);
}
