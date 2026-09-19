import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ServiceTier } from "./types.ts";
export declare function applyServiceTierPricing(usage: AssistantMessage["usage"], serviceTier: ServiceTier, model: Model<Api>): void;
export declare function resolveCodexServiceTier(responseServiceTier: ServiceTier, requestServiceTier: ServiceTier): ServiceTier;
export declare function finalizeUsage(output: AssistantMessage): void;
