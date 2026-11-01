import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";

/** Load the actual host SDK's sandbox class through the native ESM boundary. */
export function loadNativeCodemodeSandboxClass(sdkDirectory: string): Promise<typeof CodemodeSandboxBase>;
