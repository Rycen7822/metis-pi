import { PREFLIGHT_AVAILABLE_CHANNEL, PREFLIGHT_PROTOCOL, PREFLIGHT_REQUEST_CHANNEL, isPreflightBroker, } from "./tools/code-mode/preflight-protocol.js";
export function registerCodeModeToolPreflight(pi, preflight) {
    let broker;
    let unregisterPreflight;
    let disposed = false;
    const unregisterAvailable = pi.events.on(PREFLIGHT_AVAILABLE_CHANNEL, (value) => {
        if (disposed || !isPreflightBroker(value) || value === broker)
            return;
        unregisterPreflight?.();
        broker = value;
        unregisterPreflight = value.register(preflight);
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
            unregisterPreflight?.();
            unregisterPreflight = undefined;
            broker = undefined;
        },
    };
    pi.on("session_shutdown", () => registration.dispose());
    pi.events.emit(PREFLIGHT_REQUEST_CHANNEL, { protocol: PREFLIGHT_PROTOCOL });
    return registration;
}
