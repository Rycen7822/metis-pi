import test from "node:test";
import assert from "node:assert/strict";
import * as Core from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import extension from "../../extensions/appearance.ts";

const handlers = new Map<string, (...args: any[]) => void>();
const pi = new Proxy({
  on: (e: string, h: (...args: any[]) => void) => { handlers.set(e, h); },
  getAllTools: () => [{ name: "write", sourceInfo: { source: "builtin", path: "<builtin:write>" } }],
  registerCommand: () => {}, appendEntry: () => {}, registerEntryRenderer: () => {},
}, { get(t, k) { if (!(k in t)) throw new Error(`Forbidden: ${String(k)}`); return Reflect.get(t, k); } });
Core.initTheme("dark", false);
extension(pi);
handlers.get("session_start")!({}, { hasUI: true, ui: { notify() {} } });

test("0.8.1 regression: write arg streaming across updateArgs frames never crashes render", () => {
// Real host flow: ToolExecutionComponent.updateArgs -> renderCall with lastComponent
const TE = Core.ToolExecutionComponent;
const ui = { requestRender() {} };
const nativeCall = () => new Text("NATIVE", 0, 0);
const row = new TE("write", "w-crash", { path: "/tmp/x.md" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui as unknown as TUI, process.cwd());

// simulate streaming args growth exactly like updateArgs does internally:
// the host calls row.updateArgs(partialArgs) then row.render()
for (const args of [
  { path: "/tmp/x.md" },
  { path: "/tmp/x.md", content: "# first" },
  { path: "/tmp/x.md", content: "# first\n## second line with CJK 中文" },
  { path: "/tmp/x.md", content: "# first\n## second line with CJK 中文\nthird" },
]) {
  row.updateArgs(args);
  const lines = row.render(100);   // <-- crashed here before the fix (2nd call)
  assert.ok(lines.length > 0);
}
});
