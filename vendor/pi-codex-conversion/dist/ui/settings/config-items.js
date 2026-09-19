import { buildAdapterSettings } from "./config-items-adapter.js";
import { buildContextSettings } from "./config-items-context.js";
import { buildDisplaySettings } from "./config-items-display.js";
import { buildOpenAISettings } from "./config-items-openai.js";
import { buildToolsSettings } from "./config-items-tools.js";
import { buildVoiceSettings } from "./config-items-voice.js";
export function buildConfigSettings(tab, config, theme, availableContextModels = []) {
    if (tab === "adapter")
        return buildAdapterSettings(config, theme);
    if (tab === "context")
        return buildContextSettings(config);
    if (tab === "tools")
        return buildToolsSettings(config);
    if (tab === "openai")
        return buildOpenAISettings(config);
    if (tab === "display")
        return buildDisplaySettings(config);
    if (tab === "voice")
        return buildVoiceSettings(config, availableContextModels);
    return [];
}
