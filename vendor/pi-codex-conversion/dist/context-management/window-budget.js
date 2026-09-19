import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CONTEXT_WINDOW_MIN_RESERVE, CONTEXT_WINDOW_REMINDER_THRESHOLD, renderContextWindowReminder, } from "./messages.js";
export class ContextWindowBudget {
    remindedWindows = new Set();
    reset() {
        this.remindedWindows.clear();
    }
    restore(kind, windowId) {
        if (kind === "reminder" || kind === "fallback")
            this.remindedWindows.add(windowId);
    }
    record(ctx, identity, contextTokens) {
        const remaining = this.remaining(ctx, identity, contextTokens);
        if (remaining.remainingTokens === undefined)
            return;
        const windowId = identity.currentWindowId;
        if (remaining.remainingTokens <= CONTEXT_WINDOW_REMINDER_THRESHOLD &&
            !this.remindedWindows.has(windowId)) {
            this.remindedWindows.add(windowId);
            return { content: renderContextWindowReminder(remaining.remainingTokens), kind: "reminder" };
        }
    }
    remaining(ctx, identity, contextTokens) {
        const usage = ctx.getContextUsage();
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: ctx.isProjectTrusted(),
        });
        const reserveTokens = Math.max(CONTEXT_WINDOW_MIN_RESERVE, settings.getCompactionSettings().reserveTokens);
        const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const limit = Math.max(0, contextWindow - reserveTokens);
        const tokens = contextTokens ?? usage?.tokens;
        return {
            remainingTokens: tokens === null || tokens === undefined ? undefined : Math.max(0, limit - tokens),
            windowId: identity?.currentWindowId,
            contextWindow: limit,
        };
    }
}
