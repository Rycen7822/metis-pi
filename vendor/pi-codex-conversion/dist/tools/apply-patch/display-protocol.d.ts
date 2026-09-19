export declare const APPLY_PATCH_DISPLAY_PROTOCOL = "@howaboua/pi-codex-conversion/apply-patch-display/v1";
export declare const APPLY_PATCH_DISPLAY_REQUEST_CHANNEL = "@howaboua/pi-codex-conversion/apply-patch-display/v1/request";
export declare const APPLY_PATCH_DISPLAY_AVAILABLE_CHANNEL = "@howaboua/pi-codex-conversion/apply-patch-display/v1/available";
export interface ApplyPatchDisplayBroker {
    protocol: typeof APPLY_PATCH_DISPLAY_PROTOCOL;
    isActive(): boolean;
    register(customType: string): () => void;
}
export declare function isApplyPatchDisplayRequest(value: unknown): boolean;
export declare function isApplyPatchDisplayBroker(value: unknown): value is ApplyPatchDisplayBroker;
