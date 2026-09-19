import { APPLY_PATCH_DISPLAY_AVAILABLE_CHANNEL, APPLY_PATCH_DISPLAY_PROTOCOL, APPLY_PATCH_DISPLAY_REQUEST_CHANNEL, isApplyPatchDisplayBroker, } from "./tools/apply-patch/display-protocol.js";
export function registerApplyPatchDisplay(pi, options) {
    const customType = options.customType.trim();
    if (!customType)
        throw new Error("apply_patch display customType cannot be empty");
    pi.registerEntryRenderer(customType, options.render);
    let broker;
    let unregisterDisplay;
    let disposed = false;
    const unregisterAvailable = pi.events.on(APPLY_PATCH_DISPLAY_AVAILABLE_CHANNEL, (value) => {
        if (disposed || !isApplyPatchDisplayBroker(value) || value === broker)
            return;
        unregisterDisplay?.();
        broker = value;
        unregisterDisplay = value.register(customType);
    });
    const registration = {
        get available() {
            return !disposed && (broker?.isActive() ?? false);
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            unregisterAvailable();
            unregisterDisplay?.();
            unregisterDisplay = undefined;
            broker = undefined;
        },
    };
    pi.on("session_shutdown", () => registration.dispose());
    pi.events.emit(APPLY_PATCH_DISPLAY_REQUEST_CHANNEL, {
        protocol: APPLY_PATCH_DISPLAY_PROTOCOL,
    });
    return registration;
}
