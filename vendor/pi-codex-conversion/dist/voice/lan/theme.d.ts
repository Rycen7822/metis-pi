import type { Theme } from "@earendil-works/pi-coding-agent";
export interface LanVoiceWebTheme {
    colorScheme: "dark" | "light" | "light dark";
    pageColor: string;
    variables: string;
}
export declare function resolveLanVoiceWebTheme(theme: Theme): LanVoiceWebTheme;
