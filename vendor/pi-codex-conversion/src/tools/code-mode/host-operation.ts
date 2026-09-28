/** The abort/cancel view of the host connection that operation helpers need. */
export interface OperationCanceller {
	send(message: unknown): void;
	rejectOperation(id: number, error: Error): void;
}

export function cancelOperation(
	session: OperationCanceller,
	id: number,
): Error {
	const error = abortError();
	try {
		session.send({ type: "operation/cancel", id });
	} catch {
		// Host teardown is already authoritative.
	}
	session.rejectOperation(id, error);
	return error;
}

export function abortError(): Error {
	const error = new Error("Code-mode operation aborted");
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
