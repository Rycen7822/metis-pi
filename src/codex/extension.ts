import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mergeAdapterTools, restoreTools, stripAdapterTools } from "./config/activation.ts";
import { registerCodexConversion } from "./extension/register.ts";

export default async function codexConversion(pi: ExtensionAPI): Promise<void> {
	const changelogUrl = new URL("../changelog.ts", import.meta.url);
	const { default: registerPackageChangelog } = (await import(
		changelogUrl.href
	)) as { default: (pi: ExtensionAPI) => void };
	registerPackageChangelog(pi);
	await registerCodexConversion(pi);
}

export type {
	ApplyPatchPartialFailureDetails,
	ApplyPatchRenderCall,
	ApplyPatchRenderResult,
	ApplyPatchSuccessDetails,
	ApplyPatchToolDetails,
	ApplyPatchToolOptions,
	ExecutePatchResult,
} from "./execution/apply-patch/tool.ts";
export {
	createApplyPatchTool,
	isApplyPatchToolDetails,
	registerApplyPatchResultEvent,
} from "./execution/apply-patch/tool.ts";
export {
	sendCodexDeveloperMessage,
	trySendCodexDeveloperMessage,
	type CodexDeveloperMessageDelivery,
	type CodexDeveloperMessageOptions,
} from "./developer-messages.ts";
export { mergeAdapterTools, restoreTools, stripAdapterTools };
