import type { CustomMessageEntry } from "@earendil-works/pi-coding-agent";
export declare function isProviderContextExcludedMessage(message: {
    role: string;
    customType?: string | undefined;
    content?: unknown;
    summary?: unknown;
}): boolean;
export declare function isProviderContextExcludedCustomMessageEntry(entry: CustomMessageEntry): boolean;
