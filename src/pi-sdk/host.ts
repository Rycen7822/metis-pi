import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { sdkVersion } from "./artifact.mjs";

/** Stock Pi can run the installer, but only the activated SDK owns the Metis host contracts. */
export function hasMetisHostSDK(): boolean {
  return VERSION === sdkVersion && typeof SessionManager.prototype.getBranchMetadata === "function";
}
