import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
export declare function getActiveToolsInActiveOrder(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">, codeMode?: boolean): Tool[];
