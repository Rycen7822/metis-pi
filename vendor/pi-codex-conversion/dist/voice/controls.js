import { getCodexConversionConfigPath, getProjectCodexConversionConfigPath, hasFolderCodexConversionConfig, readEffectiveCodexConversionConfig, } from "../adapter/activation/config-store.js";
import { resolveVoiceHelperBinary } from "./binary.js";
import { buildVoiceSetupInstructions } from "./setup.js";
import { registerCodexVoiceShortcuts } from "./shortcuts.js";
import { codexVoiceSetupMessage } from "./ui.js";
export function createCodexVoiceControls(options) {
    const { pi, state, voice, lanVoice } = options;
    const requestSetup = async (ctx, retryCommand, force, mode) => {
        const currentConfig = readEffectiveCodexConversionConfig({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });
        const configPath = hasFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted())
            ? getProjectCodexConversionConfigPath(ctx.cwd)
            : getCodexConversionConfigPath();
        state.config = currentConfig;
        if (!force && currentConfig.voice.audioSetupCompleted)
            return false;
        if (mode === "realtime" && voice.prepareRealtimePrompt(ctx) === undefined)
            return true;
        if (!ctx.isIdle()) {
            ctx.ui.notify("Wait for the current turn before setting up Codex voice.", "info");
            return true;
        }
        state.codexTurnState.beginTurn();
        pi.sendMessage(codexVoiceSetupMessage(buildVoiceSetupInstructions({
            config: currentConfig,
            configPath,
            helperPath: resolveVoiceHelperBinary(currentConfig.tools.customRustBinariesDir),
            retryCommand,
        })), { triggerTurn: true });
        return true;
    };
    const setup = async (ctx) => {
        await requestSetup(ctx, "/codex voice realtime", true);
    };
    const start = async (mode, ctx) => {
        if (voice.activeMode === mode)
            return;
        if (await requestSetup(ctx, `/codex voice ${mode}`, false, mode))
            return;
        await voice.start(ctx, state.config, mode);
    };
    const stop = async (_ctx) => {
        if (voice.activeMode === "dictation")
            await voice.finishDictation({ announce: true });
        else
            await voice.stop({ announce: true });
    };
    const toggle = async (mode, ctx) => {
        if (voice.activeMode === mode)
            await stop(ctx);
        else
            await start(mode, ctx);
    };
    const toggleInputMute = (ctx) => {
        const muted = !voice.inputMuted;
        if (!voice.setInputMuted(muted)) {
            ctx.ui.notify("Start realtime voice before muting the microphone", "info");
            return;
        }
        ctx.ui.notify(`Realtime microphone ${muted ? "muted" : "unmuted"}`, "info");
    };
    registerCodexVoiceShortcuts(pi, state.config, () => state.config, {
        startDictation: (ctx) => start("dictation", ctx),
        finishDictation: (ctx) => stop(ctx),
        toggleDictation: (ctx) => toggle("dictation", ctx),
        toggleRealtime: (ctx) => toggle("realtime", ctx),
        toggleInputMute,
        toggleServer: async (ctx) => {
            const enabled = !lanVoice.status().running;
            await lanVoice.setEnabled(enabled, ctx);
            if (!enabled)
                ctx.ui.notify("LAN voice server stopped", "info");
        },
    });
    return { setup, start, stop, toggleInputMute };
}
