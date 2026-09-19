import { Container, Text } from "@earendil-works/pi-tui";
import type { RenderTheme } from "../ui/tool-rendering/codex-rendering.ts";
import type { CodexContextManagementMessageDetails } from "./messages.ts";
export declare function historyNotesRenderers(namespace: "history" | "notes"): Pick<import("@earendil-works/pi-coding-agent").ToolDefinition<import("typebox").TSchema, unknown, any>, "renderCall" | "renderResult">;
export declare const newContextRenderers: Pick<import("@earendil-works/pi-coding-agent").ToolDefinition<import("typebox").TSchema, unknown, any>, "renderCall" | "renderResult">;
export declare const contextRemainingRenderers: Pick<import("@earendil-works/pi-coding-agent").ToolDefinition<import("typebox").TSchema, unknown, any>, "renderCall" | "renderResult">;
export declare function renderContextWindowBoundary(details: CodexContextManagementMessageDetails, expanded: boolean, theme: RenderTheme): Text | Container;
