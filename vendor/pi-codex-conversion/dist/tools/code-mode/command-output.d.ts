import type { CodeModeToolDefinition } from "./types.js";
export declare const plainCommandOutputFormatterSource = "(value) => {\n  const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => key !== \"output\"));\n  let prefix = \"\";\n  if (Object.keys(metadata).length > 0) {\n    try { prefix = JSON.stringify(metadata); } catch { prefix = String(metadata); }\n    prefix += \"\\n\";\n  }\n  return prefix + \"Output:\\n\" + value.output;\n}";
export declare function withPlainCommandOutput(source: string, tools: CodeModeToolDefinition[]): string;
