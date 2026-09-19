export declare const SETTINGS_TABS: readonly [{
    readonly id: "adapter";
    readonly label: "General";
}, {
    readonly id: "context";
    readonly label: "Context";
}, {
    readonly id: "tools";
    readonly label: "Tools";
}, {
    readonly id: "openai";
    readonly label: "OpenAI";
}, {
    readonly id: "display";
    readonly label: "Display";
}, {
    readonly id: "voice";
    readonly label: "Voice";
}, {
    readonly id: "usage";
    readonly label: "Usage";
}, {
    readonly id: "about";
    readonly label: "About";
}];
export type SettingsTab = typeof SETTINGS_TABS[number]["id"];
export declare const ROUTABLE_SETTINGS_TABS: ({
    readonly id: "adapter";
    readonly label: "General";
} | {
    readonly id: "context";
    readonly label: "Context";
} | {
    readonly id: "tools";
    readonly label: "Tools";
} | {
    readonly id: "openai";
    readonly label: "OpenAI";
} | {
    readonly id: "display";
    readonly label: "Display";
} | {
    readonly id: "voice";
    readonly label: "Voice";
} | {
    readonly id: "usage";
    readonly label: "Usage";
} | {
    readonly id: "about";
    readonly label: "About";
})[];
export declare function parseSettingsTab(value: string): SettingsTab | undefined;
