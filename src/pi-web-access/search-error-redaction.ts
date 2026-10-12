import { redactCredential } from "./credential-source.ts";
import { SearchHttpError } from "./search-types.ts";

export function redactSearchFailure(error: unknown, credential: string | null | undefined): { message: string; error: unknown } {
	const message = error instanceof Error ? error.message : String(error);
	const redacted = redactCredential(message, credential);
	// Keep the original thrown value unless its diagnostic exposes the credential.
	if (redacted === message) return { message, error };
	const safeError = error instanceof SearchHttpError
		? new SearchHttpError(error.status, redacted)
		: new Error(redacted);
	if (error instanceof Error) safeError.name = error.name;
	return { message: redacted, error: safeError };
}
