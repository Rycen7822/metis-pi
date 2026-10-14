import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import factory from "./index.ts";

function setup(hasUI = true) {
  const { pi, captured } = createMockPi();
  captured.allTools.push({ name: "codemode", sourceInfo: { path: "builtin:codemode" } } as never);
  pi.setActiveTools(["read", "codemode"]);
  factory(pi);
  const ctx = createMockCtx({ hasUI });
  for (const handler of captured.events.get("session_start") ?? []) handler({}, ctx);
  return { pi, captured, ctx, turn: () => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    for (const handler of captured.events.get("before_agent_start") ?? []) handler(event, ctx);
    return event;
  } };
}
describe("Metis deferred availability", () => {
  it("keeps the tool out of active declarations across UI turns, with a discovery hint", () => {
    const { pi, captured, turn } = setup();
    expect(captured.tools.get("ask_user_question")?.exposure).toBe("deferred");
    expect(pi.getActiveTools()).toEqual(["read", "codemode"]);
    expect(turn().systemPromptOptions.sections.metis_questions).toContain("describeTool");
    turn();
    expect(pi.getActiveTools()).not.toContain("ask_user_question");
  });
  it("hides the tool in no-UI mode and restores deferred availability, not activation", () => {
    const { pi, captured, ctx, turn } = setup(false);
    expect(captured.tools.get("ask_user_question")?.exposure).toBe("hidden");
    expect(turn().systemPromptOptions.sections.metis_questions).toBeUndefined();
    ctx.hasUI = true;
    turn();
    expect(captured.tools.get("ask_user_question")?.exposure).toBe("deferred");
    expect(pi.getActiveTools()).not.toContain("ask_user_question");
  });
  it("hides on disabled/malformed TOML without restoring active tools", () => {
    const { captured, turn } = setup();
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "metis-pi.toml"), "[askUserQuestion]\nenabled = false\n");
    turn(); expect(captured.tools.get("ask_user_question")?.exposure).toBe("hidden");
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "metis-pi.toml"), "[broken\n");
    expect(() => turn()).not.toThrow();
    expect(captured.tools.get("ask_user_question")?.exposure).toBe("hidden");
  });
  it("does not overwrite a foreign provider", () => {
    const { pi, captured } = createMockPi({ getAllTools: () => [{ name: "ask_user_question", sourceInfo: { path: "/foreign/index.ts" } }] as never });
    factory(pi);
    const ctx = createMockCtx();
    for (const handler of captured.events.get("session_start") ?? []) handler({}, ctx);
    expect(captured.tools.has("ask_user_question")).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalled();
  });
  it("reports changed and recurring failures after recovery without repeating the same failure", () => {
    const { pi, ctx, turn } = setup();
    const configPath = join(process.env.PI_CODING_AGENT_DIR!, "metis-pi.toml");
    pi.setActiveTools(["read"]);
    expect(turn().systemPromptOptions.sections.metis_questions).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    turn();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

    writeFileSync(configPath, "[broken\n");
    turn();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("unavailable"), "warning");
    turn();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);

    writeFileSync(configPath, "[askUserQuestion]\nenabled = true\n");
    pi.setActiveTools(["read", "codemode"]);
    expect(turn().systemPromptOptions.sections.metis_questions).toContain("describeTool");
    pi.setActiveTools(["read"]);
    turn();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(3);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("discovery"), "warning");
  });
});
