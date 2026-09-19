import type { OAuthAuth } from "@earendil-works/pi-ai";
import { type OAuthDeviceCodePollResult } from "./device-code.ts";
export declare const OPENAI_CODEX_NATIVE_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
type DeviceAuthToken = {
    authorization_code: string;
    code_verifier: string;
};
export declare function getOpenAICodexAccountId(accessToken: string): string | null;
export declare function createOpenAICodexNativeAuthorizationFlow(originator?: string): Promise<{
    verifier: string;
    state: string;
    url: string;
}>;
export declare function parseOpenAICodexDeviceAuthPollResponse(response: Response): Promise<OAuthDeviceCodePollResult<DeviceAuthToken>>;
export declare const openaiCodexNativeOAuthProvider: OAuthAuth;
export {};
