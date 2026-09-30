import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The entry owns availability; the session event bus crosses per-extension
// module loaders without leaking an enabled flag into another session.
export const ACTION_FUSION_AVAILABILITY = "metis:action-fusion-availability";

export function isActionFusionEnabled(pi: Pick<ExtensionAPI, "events">): boolean {
	const request = { enabled: false };
	pi.events.emit(ACTION_FUSION_AVAILABILITY, request);
	return request.enabled;
}
