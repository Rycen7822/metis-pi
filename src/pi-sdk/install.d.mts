export type SDKInstallation =
  | { status: "unmanaged"; restartRequired: false }
  | { status: "installed" | "current"; restartRequired: boolean; packageDir: string; patches: number };
export function ensureSDK(options?: { managedRoot?: string; runningPackageDir?: string }): Promise<SDKInstallation>;
