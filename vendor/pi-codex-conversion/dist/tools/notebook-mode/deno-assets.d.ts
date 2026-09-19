export declare const DENO_VERSION = "2.9.5";
export interface DenoAsset {
    archive: string;
    archiveSha256: string;
    archiveBytes: number;
    executable: "deno" | "deno.exe";
    binarySha256: string;
    binaryBytes: number;
}
export declare function resolveDenoAsset(platform: string, arch: string): DenoAsset;
export declare function denoAssetUrl(asset: string): string;
