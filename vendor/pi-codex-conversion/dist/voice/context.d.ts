import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
export interface RealtimeInitialMessageItem {
    type: "message";
    role: "developer" | "user" | "assistant";
    content: Array<{
        type: "input_text" | "output_text";
        text: string;
    }>;
}
export declare function buildRealtimeInitialItems(args: {
    ctx: ExtensionContext;
    config: CodexConversionConfig;
    onSummaryGenerated?: ((summary: string) => void) | undefined;
    onSummaryStatus?: ((active: boolean) => void) | undefined;
    signal?: AbortSignal | undefined;
    sourceLeafId?: string | undefined;
    forceSummary?: boolean | undefined;
}): Promise<RealtimeInitialMessageItem[] | undefined>;
export declare function renderVoiceStartupContext(summary: string): string;
