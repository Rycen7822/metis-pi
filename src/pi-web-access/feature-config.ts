import { loadWebAccessConfig } from "./utils.ts";

type FeatureConfig = { image?: { enabled?: unknown } };

function loadFeatureConfig(): FeatureConfig {
	return loadWebAccessConfig() as FeatureConfig;
}

export function isImageEnabled(): boolean {
	return loadFeatureConfig().image?.enabled !== false;
}

export function canAttachImages(): boolean {
	try {
		return isImageEnabled();
	} catch {
		return false;
	}
}
