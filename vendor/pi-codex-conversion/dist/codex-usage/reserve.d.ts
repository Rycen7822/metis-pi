import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare function createCodexReserveController(pi: ExtensionAPI): {
    modelSelected(ctx: ExtensionContext): void;
    beforeTurn(ctx: ExtensionContext): Promise<void>;
    settled(ctx: ExtensionContext): Promise<boolean>;
};
