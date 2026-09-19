import { CodexContextWindowManager, } from "./window-manager.js";
export class CodexContextWindowKickoff {
    windows;
    onContinue;
    continuation;
    postCompactionWindow;
    constructor(windows, onContinue) {
        this.windows = windows;
        this.onContinue = onContinue;
    }
    reset() {
        this.continuation = undefined;
        this.postCompactionWindow = undefined;
    }
    get pending() {
        return this.continuation !== undefined || this.postCompactionWindow !== undefined;
    }
    async startWindow(pi, ctx, options) {
        const { triggerTurn, ...windowOptions } = options;
        const started = await this.windows.startNewWindow(pi, ctx, windowOptions);
        if (!started)
            return false;
        this.continuation = undefined;
        if (!triggerTurn)
            return true;
        const identity = this.windows.currentIdentity();
        if (!identity)
            throw new Error("The new context window has no identity");
        this.continuation = {
            sessionId: ctx.sessionManager.getSessionId(),
            windowId: identity.currentWindowId,
        };
        return true;
    }
    schedulePostCompactionWindow(ctx, options) {
        this.postCompactionWindow = {
            sessionId: ctx.sessionManager.getSessionId(),
            options,
        };
    }
    async settlePostCompaction(pi, ctx) {
        const pending = this.postCompactionWindow;
        this.postCompactionWindow = undefined;
        if (!pending || pending.sessionId !== ctx.sessionManager.getSessionId())
            return false;
        return this.startWindow(pi, ctx, pending.options);
    }
    queueInput(content) {
        if (!this.continuation)
            throw new Error("No context-window continuation can accept queued input");
        this.continuation.input = content;
    }
    continue(pi, ctx) {
        const pending = this.continuation;
        if (!pending)
            return false;
        if (pending.sessionId !== ctx.sessionManager.getSessionId() ||
            pending.windowId !== this.windows.currentIdentity()?.currentWindowId) {
            this.continuation = undefined;
            return false;
        }
        if (!ctx.isIdle())
            return false;
        this.continuation = undefined;
        const input = pending.input ?? "Continue.";
        this.onContinue?.(input);
        // Only settled user input enters Pi's complete before_agent_start chain.
        pi.sendUserMessage(input, pending.input === undefined ? undefined : { expandPromptTemplates: true });
        return true;
    }
}
