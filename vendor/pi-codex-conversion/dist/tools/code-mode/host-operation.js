export function cancelOperation(session, id) {
    const error = abortError();
    try {
        session.send({ type: "operation/cancel", id });
    }
    catch {
        // Host teardown is already authoritative.
    }
    session.rejectOperation(id, error);
    return error;
}
export function operationAbort(session, id) {
    return () => {
        cancelOperation(session, id);
    };
}
export function abortError() {
    const error = new Error("Code-mode operation aborted");
    error.name = "AbortError";
    return error;
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
export function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
