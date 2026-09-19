import { isKeyRelease, isKeyRepeat, matchesKey, parseKey } from "@earendil-works/pi-tui";
const INITIAL_RELEASE_FALLBACK_MS = 650;
const REPEAT_RELEASE_FALLBACK_MS = 120;
export function registerCodexVoiceShortcuts(pi, initialConfig, getConfig, actions) {
    const dictationShortcut = initialConfig.voice.dictationShortcut;
    const realtimeShortcut = initialConfig.voice.realtimeShortcut;
    const muteShortcut = initialConfig.voice.muteShortcut;
    const serverShortcut = initialConfig.voice.serverShortcut;
    let operation = Promise.resolve();
    let removeTerminalInput;
    let dictationKeyDown;
    let releaseFallbackTimer;
    const enqueue = (ctx, action) => {
        const next = operation.then(action, action);
        operation = next.catch((error) => {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        });
        return operation;
    };
    const clearReleaseFallback = () => {
        if (releaseFallbackTimer)
            clearTimeout(releaseFallbackTimer);
        releaseFallbackTimer = undefined;
    };
    const finishPushDictation = (ctx) => {
        if (!dictationKeyDown)
            return;
        dictationKeyDown = undefined;
        clearReleaseFallback();
        void enqueue(ctx, () => actions.finishDictation(ctx));
    };
    const armReleaseFallback = (ctx, delay) => {
        clearReleaseFallback();
        releaseFallbackTimer = setTimeout(() => finishPushDictation(ctx), delay);
    };
    pi.registerShortcut(dictationShortcut, {
        description: "Codex push-to-dictate",
        handler: (ctx) => enqueue(ctx, async () => {
            const mode = getConfig().voice.dictationShortcutMode;
            if (mode === "toggle") {
                dictationKeyDown = undefined;
                clearReleaseFallback();
                await actions.toggleDictation(ctx);
            }
            else {
                dictationKeyDown = keyIdentity(dictationShortcut);
                armReleaseFallback(ctx, INITIAL_RELEASE_FALLBACK_MS);
                await actions.startDictation(ctx);
            }
        }),
    });
    pi.registerShortcut(realtimeShortcut, {
        description: "Toggle Codex realtime voice",
        handler: (ctx) => enqueue(ctx, () => actions.toggleRealtime(ctx)),
    });
    pi.registerShortcut(muteShortcut, {
        description: "Toggle Codex realtime microphone mute",
        handler: (ctx) => enqueue(ctx, async () => actions.toggleInputMute(ctx)),
    });
    pi.registerShortcut(serverShortcut, {
        description: "Toggle Codex LAN voice server",
        handler: (ctx) => enqueue(ctx, () => actions.toggleServer(ctx)),
    });
    pi.on("session_start", (_event, ctx) => {
        removeTerminalInput?.();
        dictationKeyDown = undefined;
        clearReleaseFallback();
        removeTerminalInput = ctx.ui.onTerminalInput((data) => {
            if ((matchesKey(data, realtimeShortcut) || matchesKey(data, muteShortcut) || matchesKey(data, serverShortcut)) && isKeyRepeat(data))
                return { consume: true };
            const mode = getConfig().voice.dictationShortcutMode;
            if (mode !== "push") {
                dictationKeyDown = undefined;
                clearReleaseFallback();
            }
            if (mode === "push" && dictationKeyDown && keyIdentity(parseKey(data)) === dictationKeyDown) {
                if (isKeyRelease(data))
                    finishPushDictation(ctx);
                else if (matchesKey(data, dictationShortcut))
                    armReleaseFallback(ctx, REPEAT_RELEASE_FALLBACK_MS);
                return { consume: true };
            }
            if (!matchesKey(data, dictationShortcut))
                return undefined;
            if (isKeyRepeat(data) || isKeyRelease(data))
                return { consume: true };
            return undefined;
        });
    });
    pi.on("session_shutdown", () => {
        removeTerminalInput?.();
        removeTerminalInput = undefined;
        dictationKeyDown = undefined;
        clearReleaseFallback();
    });
}
function keyIdentity(key) {
    return key?.replace(/^(?:(?:ctrl|shift|alt|super)\+)+/, "");
}
