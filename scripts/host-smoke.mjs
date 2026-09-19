// Requires the actual Pi peers. This never substitutes the test layout harness.
// Exercises the REAL assembly path: index.ts default export + Pi's
// ToolExecutionComponent + real pi-tui width tools, zero model calls.
// The diff-surface assertions expect the Codex RGB palette; without a TTY
// the auto-detection resolves to 256-color, so force truecolor deterministically.
process.env.FORCE_COLOR ??= "3";
process.env.COLORTERM ??= "truecolor";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import { Text, MouseRegion, hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../extensions/appearance.ts";

const handlers = new Map();
const registeredCommands = [];
const appendedEntries = [];
const registeredEntryRenderers = [];
const sourceInfo = (builtin) => builtin
  ? { source: "builtin", path: "<PLACEHOLDER>" }
  : { source: "npm:compatibility-test", path: "/test/custom.ts" };
const source = (name, builtin = true) => ({
  name,
  sourceInfo: builtin ? { source: "builtin", path: `<builtin:${name}>` } : sourceInfo(false),
});
const definitions = [source("read"), source("bash"), source("write"), source("edit"), source("grep", false)];
const pi = new Proxy({
  on: (event, handler) => handlers.set(event, handler),
  getAllTools: () => definitions,
  // 0.8.0 chrome APIs (public surface; guarded assertions below):
  registerCommand: (name, options) => registeredCommands.push({ name, ...options }),
  appendEntry: (type, data) => appendedEntries.push({ type, data }),
  registerEntryRenderer: (type, renderer) => registeredEntryRenderers.push({ type, renderer }),
}, { get(target, key) {
  if (!(key in target)) throw new Error(`Forbidden extension API: ${String(key)}`);
  return target[key];
} });
Core.initTheme("dark", false);
const proto = Core.ToolExecutionComponent.prototype;
const before = Object.getOwnPropertyDescriptors(proto);
extension(pi);
handlers.get("session_start")({}, { hasUI: true, ui: { notify(text) { throw new Error(text); } } });
const ui = { requestRender() {} };
const nativeCall = () => new Text("NATIVE", 0, 0);
const fire = (event, ctx = { cwd: process.cwd() }) => handlers.get(event.type)(event, ctx);

// ---- 1. Exploration: single title, folded by default ------------------------
const row = new Core.ToolExecutionComponent("read", "read-smoke", { path: "example.ts" }, { showImages: false }, { name: "read", renderCall: nativeCall }, ui, process.cwd());
row.markExecutionStarted();
const payload = { content: [{ type: "text", text: "alpha\nbeta" }], isError: false };
const saved = JSON.stringify(payload);
row.updateResult(payload);
let rendered = stripVTControlCharacters(row.render(100).join("\n"));
assert.match(rendered, /• Explored/);
assert.match(rendered, /  └ Read example\.ts/);
assert.doesNotMatch(rendered, /alpha/);
assert.equal(row.getRenderShell(), "self");
row.setExpanded(true);
assert.match(stripVTControlCharacters(row.render(40).join("\n")), /beta/);
assert.equal(JSON.stringify(payload), saved);
assert.equal(definitionSafe(row), true);
function definitionSafe(r) { return r.toolDefinition.renderCall === nativeCall; }

// ---- 2. Bash: TWO slots, ONE structural title --------------------------------
const bashRow = new Core.ToolExecutionComponent("bash", "bash-smoke", { command: "printf hello" }, { showImages: false }, { name: "bash", renderCall: nativeCall }, ui, process.cwd());
bashRow.markExecutionStarted();
const bashOut = stripVTControlCharacters(bashRow.render(80).join("\n"));
assert.match(bashOut, /• Running printf hello/);
assert.equal((bashOut.match(/• Running/g) ?? []).length, 1, "partial must have exactly one title");
bashRow.updateResult({ content: [{ type: "text", text: "hello\nworld" }], isError: false });
const bashDone = stripVTControlCharacters(bashRow.render(80).join("\n"));
assert.equal((bashDone.match(/• Ran/g) ?? []).length, 1, "exactly one Ran head");
assert.match(bashDone, /  └ hello/);
assert.match(bashDone, /world/);
assert.doesNotMatch(bashDone, /• Ran[\s\S]*• Ran/);

// ---- 3. Mouse: title click expands, second click folds -----------------------
const beforeClick = bashRow.expanded;
bashRow.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 6 });
assert.equal(bashRow.expanded, !beforeClick, "click on the row toggles expansion");
bashRow.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 6 });
assert.equal(bashRow.expanded, beforeClick, "second click folds again");

// ---- 4. Write add: tracker fires, body shows the green surface, expandable ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-smoke-"));
const target = path.join(dir, "new.ts");
const writeRow = new Core.ToolExecutionComponent("write", "write-smoke", { path: target, content: "one\ntwo\n" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui, process.cwd());
writeRow.markExecutionStarted();
fire({ type: "tool_execution_start", toolCallId: "write-smoke", toolName: "write", args: { path: target, content: "one\ntwo\n" } });
fs.writeFileSync(target, "one\ntwo\n");
fire({ type: "tool_execution_end", toolCallId: "write-smoke", toolName: "write", result: { content: [{ type: "text", text: `Successfully wrote to ${target}` }] }, isError: false });
writeRow.updateResult({ content: [{ type: "text", text: `Successfully wrote to ${target}` }], isError: false });
const writeDone = stripVTControlCharacters(writeRow.render(80).join("\n"));
assert.match(writeDone, /• Added/, "tracker add must switch the title to Added");
assert.match(writeDone, /\+2 -0/);
assert.match(writeDone, /one/);
// Expansion keeps the full content reachable.
writeRow.setExpanded(true);
const writeExpanded = stripVTControlCharacters(writeRow.render(80).join("\n"));
assert.match(writeExpanded, /two/);

// ---- 5. Write unchanged: never an empty component ----------------------------
const sameTarget = path.join(dir, "same.txt");
fs.writeFileSync(sameTarget, "same\n");
const sameRow = new Core.ToolExecutionComponent("write", "same-smoke", { path: sameTarget, content: "same\n" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui, process.cwd());
sameRow.markExecutionStarted();
fire({ type: "tool_execution_start", toolCallId: "same-smoke", toolName: "write", args: { path: sameTarget, content: "same\n" } });
fire({ type: "tool_execution_end", toolCallId: "same-smoke", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
sameRow.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
const sameOut = stripVTControlCharacters(sameRow.render(80).join("\n"));
assert.match(sameOut, /unchanged/);
assert.match(sameOut, /same/);
sameRow.setExpanded(true);
assert.match(stripVTControlCharacters(sameRow.render(80).join("\n")), /same/);

// ---- 6. Third-party write (same name, extension source): back off fully ------
const extRow = new Core.ToolExecutionComponent("write", "ext-smoke", { path: path.join(dir, "ext.txt"), content: "x\n" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui, process.cwd());
const extDefs = [...definitions, { name: "write", sourceInfo: { source: "npm:compatibility-test", path: "/test/custom.ts" } }];
// simulate an extension-owned write being the LAST registration (Pi registry order)
const savedDefs = definitions.splice(0, definitions.length, ...extDefs.slice(-1));
extRow.markExecutionStarted();
fire({ type: "tool_execution_start", toolCallId: "ext-smoke", toolName: "write", args: { path: path.join(dir, "ext.txt"), content: "x\n" } });
// With the extension-owned tool as the only registry entry, ownership fails and
// the row falls back to NATIVE rendering.
assert.match(stripVTControlCharacters(extRow.render(80).join("\n")), /NATIVE/, "extension-owned write must fall back to the native renderer");
definitions.splice(0, definitions.length, ...savedDefs);

// ---- 7. Edit: rich diff through the same renderer ----------------------------
const editRow = new Core.ToolExecutionComponent("edit", "edit-smoke", { path: "example.ts" }, { showImages: false }, { name: "edit", renderCall: nativeCall }, ui, process.cwd());
editRow.markExecutionStarted();
editRow.updateResult({
  content: [{ type: "text", text: "Successfully replaced text" }],
  details: { diff: "  9 before\n-10 old value that wraps\n+10 new value that wraps\n  11 after" },
  isError: false,
});
const editRaw = editRow.render(24).join("\n");
const editPlain = stripVTControlCharacters(editRaw);
assert.match(editRaw, /\x1b\[48;2;74;34;29m/);
assert.match(editRaw, /\x1b\[48;2;33;58;43m/);
assert.match(editPlain, /10 -old value/);
assert.match(editPlain, /10 \+new value/);

// ---- 8. Foreign renderer + teardown unchanged --------------------------------
const custom = new Core.ToolExecutionComponent("grep", "custom-smoke", {}, {},
  { renderCall: nativeCall }, ui, process.cwd());
assert.match(stripVTControlCharacters(custom.render(100).join("\n")), /NATIVE/);
assert.equal(custom.getRenderShell(), "default");
handlers.get("session_shutdown")({}, {});
assert.deepEqual(Object.getOwnPropertyDescriptors(proto), before);
assert.match(stripVTControlCharacters(row.render(100).join("\n")), /NATIVE/);
assert.equal(row.getRenderShell(), "default");
// ---- 9. 0.8.5 chrome: /codex-ui diagnostics + entry renderer registration ---
// Section 8 ran session_shutdown (host data unbound) — start a fresh session.
handlers.get("session_start")({}, { hasUI: true, ui: { notify(text) { throw new Error(text); } } });
const codexUi = registeredCommands.find((cmd) => cmd.name === "codex-ui");
assert.ok(codexUi, "/codex-ui command registered");
const notified = [];
codexUi.handler("", { ui: { notify: (t) => notified.push(t) } });
const diagnostics = notified.join("\n");
assert.match(diagnostics, /pi-codex-appearance [\w.-]+ diagnostics \(mode=\w+, pi=[\w.-]+/);
assert.match(diagnostics, /thinking=peek\/collapsed/, "effective thinking policy surfaced (peek/collapsed default)");
assert.match(diagnostics, /thinking: policy=peek\/collapsed peekLines=6 autoVisibility=\d+/, "0.9.2 thinking policy + 0.12.0 peek height + applied-transition count");
assert.match(diagnostics, /composer: surface=\S+.*prefix=\S+ metadata=\S+/);
assert.match(diagnostics, /working: (idle|active) /);
assert.match(diagnostics, /codex quota: mode=auto source=codex-app-server /);
assert.match(diagnostics, /chrome: editor=\S+ footer=\S+ header=\S+ working=\S+/);
assert.match(diagnostics, /transcript:/);
assert.match(diagnostics, /decorations:/);
assert.match(diagnostics, /outcome: /);
assert.ok(registeredEntryRenderers.some((r) => r.type === "pi-codex-appearance:interaction-summary:v1"), "summary entry renderer registered");

// ---- 9b. TUI-mode chrome install: widget above editor, native loader hidden --
const chromeSlots = {
  widgets: [], workingVisible: [], footers: [], editors: [], headers: [], statuses: [],
};
const tuiUi = {
  notify(text) { throw new Error(text); },
  setWidget: (key, content, options) => chromeSlots.widgets.push({ key, content, options }),
  setWorkingVisible: (v) => chromeSlots.workingVisible.push(v),
  setWorkingIndicator: () => {},
  setWorkingMessage: () => {},
  setStatus: (key, text) => chromeSlots.statuses.push({ key, text }),
  setFooter: (factory) => chromeSlots.footers.push(factory),
  setHeader: (factory) => chromeSlots.headers.push(factory),
  setEditorComponent: (factory) => chromeSlots.editors.push(factory),
  getEditorComponent: () => chromeSlots.editors.at(-1),
};
handlers.get("session_start")({}, {
  mode: "tui",
  hasUI: true,
  cwd: process.cwd(),
  model: { id: "smoke-model", name: "Smoke", provider: "smoke-provider", contextWindow: 1_000_000 },
  thinkingLevel: "high",
  getContextUsage: () => ({ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }),
  sessionManager: { getEntries: () => [] },
  ui: tuiUi,
});
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(chromeSlots.workingVisible.at(-1), false, "native loader hidden after widget install");
assert.ok(chromeSlots.widgets.some((c) => c.key === "pi-codex-appearance:composer-meta" && c.content !== undefined),
  "composer metadata widget installed below the editor");
const metaComponent = chromeSlots.widgets.find((c) => c.key === "pi-codex-appearance:composer-meta" && c.content !== undefined)
  .content({ requestRender() {} }, { fg: (_k, t) => t });
const metaFrame = metaComponent.render(120).join("\n");
const metaPlain = metaFrame.replace(/\x1b\[[0-9;]*m/g, "");
assert.match(metaPlain, /smoke-model/, "metadata model from live host fields");
assert.match(metaPlain, /high/, "metadata thinking level");
assert.match(metaPlain, /smoke-provider/, "metadata provider");
assert.match(metaPlain, /12k\/1\.0M/, "metadata context usage");
assert.match(metaPlain, /1\.2%/, "metadata context percent");
// While idle the widget row is hidden (setWidget(undefined)); agent_start
// shows it for the active interaction.
handlers.get("agent_start")({ type: "agent_start" }, {});
const showCall = chromeSlots.widgets.find((c) => c.content !== undefined && c.key === "pi-codex-appearance:working");
assert.ok(showCall, "widget shown for the active interaction");
assert.equal(showCall.key, "pi-codex-appearance:working");
assert.deepEqual(showCall.options, { placement: "aboveEditor" });
// The installed footer renders the REAL host fields.
assert.ok(chromeSlots.footers.length >= 1, "footer factory installed");
const footerComponent = chromeSlots.footers[0]({ requestRender() {} }, { fg: (_k, t) => t }, {
  getGitBranch: () => "smoke-branch",
  getExtensionStatuses: () => new Map(),
  onBranchChange: () => () => {},
});
const footerFrame = footerComponent.render(120).join("\n");
assert.doesNotMatch(footerFrame, /smoke-model/, "model/context live in the composer surface, not the footer (0.8.5 split)");
assert.doesNotMatch(footerFrame, /12k\/1\.0M/);
// Working line through the real component path.
const widgetComponent = showCall.content({ requestRender() {} }, { fg: (_k, t) => t });
const workingFrame = widgetComponent.render(100).join("\n");
const workingPlain = workingFrame.replace(/\x1b\[[0-9;]*m/g, "");
assert.match(workingPlain, /• Working \(\d+s · esc to interrupt\)/, "Codex status rhythm");
handlers.get("agent_settled")({ type: "agent_settled" }, {});
assert.equal(chromeSlots.widgets.at(-1).content, undefined, "widget cleared at settle");

// ---- 10. agent lifecycle drives the interaction clock ------------------------
const summariesBefore = appendedEntries.filter((e) => e.type === "pi-codex-appearance:interaction-summary:v1").length;
handlers.get("agent_start")({ type: "agent_start" }, {});
handlers.get("message_start")({ type: "message_start", message: { role: "assistant", content: [] } }, {});
handlers.get("message_update")({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }, {});
handlers.get("message_end")({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } } });
handlers.get("agent_settled")({ type: "agent_settled" }, {});
// Summary recorded only when config.summary.enabled — default config in the
// smoke path has no codex-appearance.json, so defaults apply.
const summariesAfter = appendedEntries.filter((e) => e.type === "pi-codex-appearance:interaction-summary:v1").length;
assert.equal(summariesAfter - summariesBefore, 1, "exactly one summary per settled interaction");
const lastSummary = appendedEntries.at(-1).data;
assert.equal(lastSummary.schemaVersion, 2, "0.8.4 writes the v2 runtime verdict schema");
assert.equal(lastSummary.outcome, "completed", "clean stop → Worked");

// ---- 11. 0.9.2 thinking policy on the REAL prototype: collapse once, native
// click toggle, Ctrl+T respected. Assertions go through the RENDERED frame —
// the rail (makeRail) legitimately wraps the expanded Markdown, so class
// identity of the inner node is not the user-visible contract.
const thinkMessage = { role: "assistant", content: [], stopReason: null };
handlers.get("message_start")({ type: "message_start", message: thinkMessage }, {});
const thinkComp = new Core.AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, []);
const regionOf = (comp) => comp.contentContainer.children.find((c) => c instanceof MouseRegion);
const thinkFrame = (comp) => stripVTControlCharacters(comp.render(80).join("\n"));
thinkMessage.content = [{ type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL" }];
handlers.get("message_update")({ type: "message_update", message: thinkMessage }, {});
thinkComp.updateContent(thinkMessage, true);
assert.match(thinkFrame(thinkComp), /EXPANDED_THINKING_SENTINEL/, "thinking expanded while streaming");
thinkMessage.content = [
  { type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL" },
  { type: "text", text: "Answer." },
];
handlers.get("message_update")({ type: "message_update", message: thinkMessage }, {});
thinkComp.updateContent(thinkMessage, true);
assert.match(thinkFrame(thinkComp), /Thought for \d+s/, "collapsed with a duration after the text boundary");
assert.doesNotMatch(thinkFrame(thinkComp), /EXPANDED_THINKING_SENTINEL/, "body hidden once collapsed");
// 0.12.0: a left click is owned by our click layer and DELAYED by the
// double-click window, then the run renders as its peek window (the whole body
// here, since it fits). The gesture layer is the region's child, outside the
// host's own node.
const THINKING_CLICK = Symbol.for("Rycen7822.pi-codex-appearance.thinking-click.v1");
regionOf(thinkComp).handleMouse({ type: "click", button: "left", x: 5, y: 0 });
assert.doesNotMatch(thinkFrame(thinkComp), /EXPANDED_THINKING_SENTINEL/, "the click waits for a possible second one");
await new Promise((resolve) => setTimeout(resolve, 500));
assert.match(thinkFrame(thinkComp), /EXPANDED_THINKING_SENTINEL/, "single click opens the reasoning window");
assert.equal(regionOf(thinkComp).child[THINKING_CLICK], true, "click layer sits outside the host body");
assert.equal(thinkComp.thinkingVisibilityOverrides.get(0), false, "the click wrote the host override (shown)");
thinkComp.setHideThinkingBlock(false);
assert.match(thinkFrame(thinkComp), /EXPANDED_THINKING_SENTINEL/, "Ctrl+T show not fought by the policy");
thinkComp.updateContent(thinkMessage);
assert.match(thinkFrame(thinkComp), /EXPANDED_THINKING_SENTINEL/, "redraws keep manual/global expansion");
// The user message card: UserMessageComponent paints a surface via the
// native userMessageBg slot (the builtin dark theme also carries one — the
// mechanism is what this asserts; the codex value is covered by unit tests).
const userSurface = new Core.UserMessageComponent("surface smoke test");
assert.ok(
  userSurface.render(80).some((row) => /\x1b\[48;[0-9;]*m/.test(row)),
  "user message rows carry the theme surface",
);

// 0.14.0: glyph presentation. The selector is inserted at the LAST mile
// (terminal writes only), so pi-tui's own layout math must be unchanged: U+FE0E
// is zero-width and must not widen the ✔/✖ cluster. Then the write hook must
// rewrite a REAL pi-tui frame string (SGR styling + OSC 8 hyperlink) without
// touching the escape sequences themselves.
{
  const { createGlyphPresentation } = await import("../src/glyph-presentation.ts");
  assert.equal(visibleWidth("\u2716\uFE0E"), visibleWidth("\u2716"), "VS15 is zero-width: layout does not move");
  assert.equal(visibleWidth("\u2714\uFE0E done"), visibleWidth("\u2714 done"));
  const written = [];
  const glyphSystem = createGlyphPresentation({ enabled: true });
  assert.equal(glyphSystem.installOnTui({ terminal: { write: (data) => written.push(data) } }), true);
  const styled = `\x1b[1m${hyperlink("\u2714 link", "https://x.test/\u2716")}\x1b[0m plain \u2716 tail`;
  written.push(glyphSystem.present(styled)); // same transform the write hook applies
  const out = written[0];
  assert.ok(out.includes("\u2714\uFE0E link"), "styled mark gained the text-presentation selector");
  assert.ok(out.includes("https://x.test/\u2716"), "OSC 8 URL stayed byte-identical");
  assert.ok(out.endsWith("plain \u2716\uFE0E tail"), "plain marks normalized too, SGR tail intact");
  const disabled = createGlyphPresentation({ enabled: false });
  assert.equal(disabled.installOnTui({ terminal: { write: () => {} } }), false, "disabled config installs nothing");
}

fs.rmSync(dir, { recursive: true, force: true });

// ---- codex-todo entry: registrations + session wiring ----------------------
// Separate fake pi: the appearance Proxy above throws on unknown APIs, while
// the todo entry legitimately registers a tool, two commands and a shortcut.
const todoExtension = (await import("../extensions/todo.ts")).default;
const todoCalls = { tools: [], commands: [], shortcuts: [], handlers: new Map() };
const todoPi = {
  on: (event, handler) => todoCalls.handlers.set(event, handler),
  registerTool: (opts) => todoCalls.tools.push(opts),
  registerCommand: (name, options) => todoCalls.commands.push({ name, ...options }),
  registerShortcut: (key, options) => todoCalls.shortcuts.push({ key, ...options }),
};
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-todo-smoke-"));
todoExtension(todoPi);
assert.deepEqual(todoCalls.tools.map((t) => t.name), ["todo"]);
assert.deepEqual(todoCalls.commands.map((c) => c.name), ["todos", "todos-doctor"]);
assert.deepEqual(todoCalls.shortcuts, [], "no shortcuts: the widget is mouse-only since 0.17.3");
const todoNotices = [];
const todoWidgets = [];
todoCalls.handlers.get("session_start")({}, {
  cwd: tmpCwd,
  sessionManager: { getSessionId: () => "smoke" },
  ui: { notify: (t) => todoNotices.push(t), setWidget: (key, content, options) => todoWidgets.push({ key, content, options }) },
});
assert.ok(fs.existsSync(path.join(tmpCwd, ".pi", "codex-todos")), "session_start opens the store in cwd");
const todoTool = todoCalls.tools[0];
const todoResult = await todoTool.execute("call1", { action: "add", tasks: [{ title: "smoke task" }] }, undefined, () => {}, {
  sessionManager: { getSessionId: () => "smoke" },
});
assert.match(todoResult.content[0].text, /added 1 task\(s\): #1 smoke task/);
// The changed hook registered the persistent widget with the host.
assert.ok(todoWidgets.some((w) => w.key === "codex-todo" && typeof w.content === "function" && w.options?.placement === "aboveEditor"), "widget registered aboveEditor with a factory");
const todoList = await todoTool.execute("call2", { action: "list" }, undefined, () => {}, { sessionManager: { getSessionId: () => "smoke" } });
assert.match(todoList.content[0].text, /Todos: 0\/1 done/);
fs.rmSync(tmpCwd, { recursive: true, force: true });

// Skill-mux expansion shape against the REAL user-message parser. The host
// folds exactly ONE leading skill block per user message (parseSkillBlock);
// sibling blocks put every later skill into the raw user-message component,
// which is what showed up expanded in the transcript. Ours must stay inside
// that single block while keeping every skill body and the trailing text.
const muxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skillmux-smoke-"));
for (const name of ["alpha", "beta"]) {
  const dir = path.join(muxRoot, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body.\n`);
}
const { createSkillMux } = await import("../src/skill-mux.ts");
const mux = createSkillMux({ agentDir: muxRoot, cwd: muxRoot });
const expanded = mux.expand("/skill:alpha /skill:beta tail text");
assert.ok(expanded, "multi-skill input expands");
const parsed = Core.parseSkillBlock(expanded);
assert.ok(parsed, "the expansion parses as a skill block (single folded entry)");
assert.equal(parsed.name, "alpha", "the parsed block keeps the first skill's name");
assert.ok(parsed.content.includes('<skill name="beta"'), "the second skill body sits inside the parsed block");
assert.equal(parsed.userMessage, "tail text", "only the real user text stays outside the folded block");
fs.rmSync(muxRoot, { recursive: true, force: true });

console.log("PASS: real Pi two-slot assembly — one title per toolCallId, write five states, mouse expand/fold, third-party back-off, teardown restored; multi-skill expansion folds into one parsed skill block; 0.8.5 chrome (composer surface + metadata widget, compact footer, Codex Working rhythm, codex-app-server quota) OK");
