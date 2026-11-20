import { join } from "node:path";
import { metisConfigPath } from "../configuration/store.ts";
import { readWebAccessConfig, updateWebAccessConfig, webAccessAgentDir, WEB_CREDENTIALS_FILE } from "../configuration/web-access.ts";

export function webCredentialsPath(): string {
	return join(webAccessAgentDir(), WEB_CREDENTIALS_FILE);
}

export function webPreferencesPath(): string {
	return metisConfigPath(webAccessAgentDir());
}

export function loadWebAccessConfig(): Record<string, any> {
	return readWebAccessConfig(webAccessAgentDir());
}

export function saveWebAccessConfig(patch: Record<string, unknown>): void {
	updateWebAccessConfig(webAccessAgentDir(), patch);
}
