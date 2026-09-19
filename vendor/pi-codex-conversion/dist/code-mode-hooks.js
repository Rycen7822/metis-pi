import { PREFLIGHT_AVAILABLE_CHANNEL, PREFLIGHT_PROTOCOL, PREFLIGHT_REQUEST_CHANNEL, isPreflightBroker, } from "./tools/code-mode/preflight-protocol.js";
export { registerCodeModeToolPreflight, } from "./code-mode-preflight.js";
export function registerCodeModeToolCompletion(pi, completion) {
    let broker;
    let unregister;
    let disposed = false;
    const stopDiscovery = pi.events.on(PREFLIGHT_AVAILABLE_CHANNEL, (value) => {
        if (disposed || !isPreflightBroker(value) || value === broker)
            return;
        unregister?.();
        broker = value;
        unregister = typeof value.registerCompletion === "function"
            ? value.registerCompletion(completion)
            : undefined;
    });
    const registration = {
        get available() {
            return !disposed && !!unregister && (broker?.isActive() ?? false);
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            stopDiscovery();
            unregister?.();
            unregister = undefined;
            broker = undefined;
        },
    };
    pi.on("session_shutdown", () => registration.dispose());
    pi.events.emit(PREFLIGHT_REQUEST_CHANNEL, { protocol: PREFLIGHT_PROTOCOL });
    return registration;
}
