import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings } from "@earendil-works/pi-tui";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import { ASK_USER_BLOCKED_EVENT } from "./events.ts";
const args = { questions: [{ question: "Which approach?", header: "Approach", options: [
  { label: "First", description: "First approach" }, { label: "Second", description: "Second approach" },
] }] };
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s, strikethrough: (s: string) => s };
describe("tool execution cancellation", () => {
  it("aborts an actual TUI session through done, releases inline ownership, and allows another questionnaire", async () => {
    const { pi, captured } = createMockPi();
    registerAskUserQuestionTool(pi);
    const tool = captured.tools.get("ask_user_question")!;
    const controller = new AbortController();
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const overlays: boolean[] = [];
    const mount = vi.fn((factory: any, options: any) => new Promise(resolve => {
      overlays.push(options.overlay);
      factory({ requestRender() {}, terminal: { columns: 120, rows: 24 }, hasOverlay: () => false }, theme, getKeybindings(), resolve);
      opened();
    }));
    const ctx = createMockCtx({ hasUI: true, ui: { custom: mount as any } });
    const pending = tool.execute("abort", args as any, controller.signal, undefined, ctx);
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(captured.eventsEmitted.get(ASK_USER_BLOCKED_EVENT)?.at(-1)).toEqual({ active: false });
    expect(overlays).toEqual([false]);
    ctx.ui.custom = vi.fn(async (factory: any, options: any) => {
      overlays.push(options.overlay);
      const component = factory({ requestRender() {}, terminal: { columns: 120, rows: 24 }, hasOverlay: () => false }, theme, getKeybindings(), () => {});
      component.render(120);
      return { answers: [], cancelled: true };
    }) as any;
    await tool.execute("next", args as any, undefined, undefined, ctx);
    expect(overlays).toEqual([false, false]);
  });
  it("does not mount any UI for a pre-aborted call", async () => {
    const { pi, captured } = createMockPi();
    registerAskUserQuestionTool(pi);
    const controller = new AbortController(); controller.abort();
    const custom = vi.fn();
    await expect(captured.tools.get("ask_user_question")!.execute("abort", args as any, controller.signal, undefined,
      createMockCtx({ hasUI: true, ui: { custom } }))).rejects.toThrow();
    expect(custom).not.toHaveBeenCalled();
  });
});
