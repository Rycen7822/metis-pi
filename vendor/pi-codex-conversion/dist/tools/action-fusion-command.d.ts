import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ThenRunInput, type FusionCommandResult } from "./action-fusion.ts";
import type { ExecSessionManager } from "./exec/session-manager.ts";
export declare function fusionArchiveDirectory(ctx: ExtensionContext): string;
/** Native shell owns spawning/env/process cleanup; this wrapper captures evidence before truncation. */
export declare function runNativeFusionCommand(input: ThenRunInput, ctx: ExtensionContext, signal?: AbortSignal, update?: (result: FusionCommandResult) => void): Promise<FusionCommandResult>;
/** Conversion retains its existing session/env/bridge ownership and output decoder. */
export declare function runExecFusionCommand(sessions: ExecSessionManager, input: ThenRunInput, ctx: ExtensionContext, signal?: AbortSignal, update?: (result: FusionCommandResult) => void): Promise<FusionCommandResult>;
