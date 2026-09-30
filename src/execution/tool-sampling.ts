import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";

const PREFER_STRICT_TOOL_SAMPLING = {
	type: "json_schema",
	strict: "prefer",
} as const satisfies ConstrainedSamplingConfig;

export function getExperimentalToolSampling(
	toolName: string,
): ConstrainedSamplingConfig | undefined {
	return process.env["PI_EXPERIMENTAL"] === "1" && toolName === "exec_command"
		? PREFER_STRICT_TOOL_SAMPLING
		: undefined;
}
