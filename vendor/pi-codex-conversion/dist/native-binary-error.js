const RECOVERY = "Build the native helpers locally, set `tools.customRustBinariesDir` in `pi-codex-conversion.json`, then run `/reload`";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorCode(error) {
    if (!error || typeof error !== "object" || !("code" in error))
        return undefined;
    return typeof error.code === "string" ? error.code : undefined;
}
export function nativeBinaryRecoveryMessage(helper, error, options = {}) {
    if ((options.platform ?? process.platform) !== "linux")
        return undefined;
    const message = errorMessage(error);
    const loaderFailure = /Could not start dynamically linked executable|NixOS cannot run dynamically linked|stub-ld|(?:version [`']?)?GLIBC_[0-9.]+[`']? not found|error while loading shared libraries: [^\n]+: cannot open shared object file/i.test(message);
    const startupPipeFailure = options.startupWriteFailure === true &&
        (errorCode(error) === "EPIPE" || /\bEPIPE\b|broken pipe/i.test(message));
    const missingInterpreter = errorCode(error) === "ENOENT" &&
        !!options.binaryPath &&
        existsSync(options.binaryPath);
    if (!loaderFailure && !startupPipeFailure && !missingInterpreter)
        return undefined;
    return `${helper} cannot run on this system. ${RECOVERY}`;
}
export function formatNativeBinaryError(helper, error, options) {
    return (nativeBinaryRecoveryMessage(helper, error, options) ?? errorMessage(error));
}
import { existsSync } from "node:fs";
