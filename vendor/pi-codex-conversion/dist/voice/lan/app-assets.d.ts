import type { Theme } from "@earendil-works/pi-coding-agent";
export interface LanVoiceAppAsset {
    contentType: string;
    body: Buffer;
}
export declare function getLanVoiceAppAsset(path: string): LanVoiceAppAsset | undefined;
export declare function createLanVoiceWebManifest(piTheme: Theme): string;
