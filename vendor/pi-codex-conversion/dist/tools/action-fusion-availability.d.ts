import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare const ACTION_FUSION_AVAILABILITY = "metis:action-fusion-availability";
export declare function isActionFusionEnabled(pi: Pick<ExtensionAPI, "events">): boolean;
