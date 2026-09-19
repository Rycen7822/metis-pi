export const CANCELLED = Symbol("voice-operation-cancelled");
export function interruptible(operation, signal) {
    if (!signal)
        return operation;
    if (signal.aborted)
        return Promise.resolve(CANCELLED);
    return new Promise((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener("abort", onAbort); resolve(CANCELLED); };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
    });
}
