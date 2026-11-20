export const OPENAI_CYBERSECURITY_FLAG = "This content was flagged for possible cybersecurity risk.";

export interface OpenAISafetyMessage {
  provider?: string;
  stopReason?: string;
  rawStopReason?: string;
  errorMessage?: string;
}

function errorDetail(message: OpenAISafetyMessage): string | undefined {
  // Older provider errors sometimes prefix the provider's explicit safety text.
  return message.errorMessage?.replace(/^(?:Error Code [\w-]+|Codex error|[\w-]+):\s*/, "");
}

function isOpenAIError(message: OpenAISafetyMessage | undefined): message is OpenAISafetyMessage {
  return !!message && message.stopReason === "error" && (message.provider === "openai" || message.provider === "openai-codex");
}

export function isOpenAICybersecurityRefusal(message: OpenAISafetyMessage | undefined): boolean {
  return isOpenAIError(message) && errorDetail(message)?.startsWith(OPENAI_CYBERSECURITY_FLAG) === true;
}

export function openAISafetyNotice(message: OpenAISafetyMessage | undefined): string | undefined {
  if (!isOpenAIError(message)) return;
  if (isOpenAICybersecurityRefusal(message)) return `OpenAI safety policy blocked the response: ${OPENAI_CYBERSECURITY_FLAG}`;
  if (message.rawStopReason === "incomplete.content_filter") return "OpenAI content filter stopped the response.";
}
