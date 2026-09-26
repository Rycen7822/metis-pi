// The real Pi user-message component loads the shipped theme and paints its native surface.
const previousEnv = Object.fromEntries(
  ["NO_COLOR", "FORCE_COLOR", "COLORTERM", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
);
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const { default: test, after } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const Core = await import("@earendil-works/pi-coding-agent");

// Activate THIS package's theme through the host's own loader (custom themes
// live at <agentDir>/themes; getAgentDir honors PI_CODING_AGENT_DIR) so the
// host components render the real palette. Deep theme imports are
// exports-blocked, and the theme singleton cannot be swapped from the API.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-theme-"));
after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
});
fs.mkdirSync(path.join(agentDir, "themes"), { recursive: true });
fs.copyFileSync(
  fileURLToPath(new URL("../../themes/metis-pi.json", import.meta.url)),
  path.join(agentDir, "themes", "metis-pi.json"),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
Core.initTheme("metis-pi", false);

test("real UserMessageComponent paints the gray surface from the native theme slot", () => {
  const text = "帮我看看这段很长的用户消息在终端宽度下如何折行，背景应当铺满每一行包括右侧内边距，并且不能泄漏到下一块。";
  const comp = new Core.UserMessageComponent(text);
  const width = 60;
  const rows = comp.render(width);
  assert.ok(rows.length > 2, "message wraps at this width");
  for (const row of rows) {
    assert.ok(row.includes("\x1b[48;2;41;41;41m"), "the native palette paints every row #292929");
    assert.ok(row.includes("\x1b[49m"), "background resets before the next component");
  }
});
