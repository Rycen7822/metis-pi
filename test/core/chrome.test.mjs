import test from "node:test";
import assert from "node:assert/strict";
import { createFooterComponent, layoutFooter } from "../../src/appearance/chrome/footer.ts";
import * as Tui from "@earendil-works/pi-tui";
import { sgr } from "../helpers.mjs";
import { altScreen, screenLines } from "../helpers/ui-fixtures.mjs";
import { setPruneStatusWidget } from "../../src/condense/commands.ts";
import { DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { cellWidth, clipLine, truncateSegments } from "../../src/presentation/segments.ts";

test("chrome clipping keeps terminal graphemes and excludes ANSI from cell counts", () => {
  assert.equal(cellWidth("é👩‍🔬"), 3);
  assert.equal(cellWidth("\x1b[31mX\x1b[0m"), 1);
  assert.equal(clipLine("éZ", 1), "é");
  assert.equal(clipLine("👩‍🔬Z", 2), "👩‍🔬");
  assert.equal(clipLine("👩‍🔬Z", 1), "");
  assert.equal(clipLine("A中", 2), "A");
  assert.deepEqual(truncateSegments([{ text: "👩‍🔬XYZ", tone: "dim" }], 3), [{ text: "👩‍🔬…", tone: "dim" }]);
});

test("footer wraps ordered metadata into literal narrow and wide rows", () => {
  const snapshot = {
    model: { id: "gpt-6-sol", provider: "openai-codex", contextWindow: 272_000 },
    thinkingLevel: "xhigh",
    contextUsage: { tokens: 49_600, contextWindow: 272_000, percent: 18.2 },
    cwd: "/tmp/codex_workspace",
    session: { input: 106_000, output: 8_900, cacheRead: 851_000, cacheWrite: 0, costTotal: 0 },
    cacheLastPct: 99.9,
    revision: 1,
  };
  const show = { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true };
  const rows = (width, options = show) => layoutFooter(snapshot, options, width)
    .map((row) => row.map((span) => span.text).join(""));
  const identity = "gpt-6-sol · xhigh · openai-codex";
  const context = "ctx 49.6k/272k · 18.2%";
  const usage = "↑106k ↓8.9k · cache 99.9%";
  assert.deepEqual(rows(60), [`${identity} · ${context}`, usage]);
  assert.deepEqual(rows(200), [`${identity} · ${context} ${usage}`]);
  assert.deepEqual(rows(140, { ...show, metadata: false }), [usage]);
  assert.deepEqual(layoutFooter(snapshot, show, 0), [], "0 columns: hidden, no crash");
  assert.deepEqual(layoutFooter(snapshot, show, 1), []);
  assert.deepEqual(layoutFooter(snapshot, show, 2), []);

});

test("footer keeps unknown context distinct from zero usage", () => {
  const snapshot = {
    model: { id: "m", provider: "p", contextWindow: 272_000 },
    thinkingLevel: undefined, contextUsage: { tokens: null, contextWindow: 272_000, percent: null },
    cwd: "/tmp/work", session: undefined, cacheLastPct: null, speed: undefined, changes: undefined, revision: 1,
  };
  const show = { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true };
  const text = (s) => layoutFooter(s, show, 100).flat().map((seg) => seg.text).join("");
  assert.match(text(snapshot), /ctx —\/272k/);
  assert.doesNotMatch(text(snapshot), /0%|↑0|cache/);
  assert.match(text({ ...snapshot, contextUsage: { tokens: 0, contextWindow: 272_000, percent: 0 } }), /ctx 0\/272k · 0%/);
});

test("header component: real identity, never impersonates OpenAI", async () => {
  const { createHeaderComponent } = await import("../../src/appearance/chrome/header.ts");
  const deps = {
    appearanceVersion: "0.8.5",
    piVersion: "0.85.1",
    getModel: () => ({ id: "test-model" }),
    getCwd: () => "/tmp/proj",
  };
  const component = createHeaderComponent(deps, { fg: (_k, t) => t });
  const joined = component.render(80).join("\n");
  assert.ok(joined.includes("metis-pi"), "own identity shown");
  assert.ok(joined.includes("test-model"), "real model id shown");
  assert.ok(!/OpenAI/i.test(joined), "never claims OpenAI");
});

test("footer disclosures are independent native mouse targets and preserve focus across updates and resize", t => {
  const snapshot = {
    model: { id: "gpt-6.1-sol", provider: "openai", contextWindow: 500_000 },
    thinkingLevel: "xhigh", contextUsage: { tokens: 157_500, contextWindow: 500_000, percent: 31.5 },
    cwd: "/home/xu/project/harness/metis-pi", session: { input: 13_800_000, output: 1_000_000 },
    cacheLastPct: 96.6, speed: { tokensPerSecond: 103, outputTokens: 1031, windowMs: 10000, reasoningTokens: 0, contentEvents: 2, sampleCount: 1 },
    changes: { additions: 99, deletions: 10 }, revision: 1,
  };
  const summary = "│ prune: ON · 743.1k->292.7k (-61%) · usage: 0 tokens";
  const queued = "7 turns queued — will evaluate packing and summary budget on agent's next final text response";
  const statuses = new Map([["vendor", "Other status stays"], ["goal", "Pursuing goal (1s)"]]);
  setPruneStatusWidget({ ui: { setStatus: (key, text) => statuses.set(key, text) } },
    { ...DEFAULT_CONFIG, enabled: true, showPruneStatusLine: true },
    { beforeChars: 743_100 * 4, afterChars: 292_700 * 4 }, undefined, 0, queued);
  const callbacks = new Set();
  let branch = "fix/output-speed-accounting", renders = 0, goalOpens = 0;
  const data = { getGitBranch: () => branch, getExtensionStatuses: () => statuses,
    onBranchChange(cb) { callbacks.add(cb); return () => callbacks.delete(cb); } };
  const deps = { getSnapshot: () => snapshot, requestRender() { renders++; }, openGoal() { goalOpens++; },
    show: { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true } };
  const footer = createFooterComponent(deps, data, text => text);
  t.after(() => footer.dispose());
  assert.equal(footer.render(160)[0],
    "gpt-6.1-sol · xhigh · openai · ctx 158k/500k · 31.5% ↑13.8M ↓1.0M · cache 96.6% · gen(last) 103 tok/s +99 -10 ▶");
  assert.ok(footer.render(160).includes(`${summary} ▶`));
  const { tui, terminal } = altScreen(160, 36);
  const editor = new Tui.Input();
  editor.setValue("pending input");
  const scroll = new Tui.ScrollView(new Tui.Text(Array.from({ length: 100 }, (_, i) => `HISTORY_${i}`).join("\n"), 0, 0),
    { primary: true, follow: "end" });
  t.after(() => scroll.hideTransientScrollbar());
  tui.setLayoutRoot(new Tui.VStack([
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
    { component: editor, shrink: 0 },
    { component: footer, shrink: 0 },
  ]));
  tui.setFocus(editor);
  const frame = () => { tui.doRender(); return screenLines(tui).join("\n"); };
  const arrows = () => screenLines(tui).flatMap((line, y) => {
    const index = line.search(/[▶▼]/);
    return index < 0 ? [] : [{ x: Tui.visibleWidth(line.slice(0, index)) + 1, y: y + 1 }];
  });
  const click = ({ x, y }) => {
    tui.handleTerminalInput(sgr(0, x, y));
    tui.handleTerminalInput(sgr(0, x, y, true));
    return frame();
  };
  assert.doesNotMatch(frame(), /project\/harness|output-speed-accounting|turns queued/);
  Object.assign(snapshot.speed, { outputTokens: 1033, contentEvents: 6, sampleCount: 3 });
  snapshot.revision++;
  assert.match(frame(), /gen\(avg3\) 103 tok\/s/, "a pooled rate is never mislabeled as the latest raw response");
  const initialViewport = scroll.viewportHeight;
  assert.ok(initialViewport > 0, "exercise the native flexible transcript viewport");
  for (const [index, detail] of [[0, /project\/harness\/metis-pi/], [1, /turns queued/]]) {
    for (const offset of [-2, 2]) {
      const point = arrows()[index];
      assert.match(click({ x: point.x + offset, y: point.y }), detail, "both edges of the padded target expand");
      const expandedPoint = arrows()[index];
      assert.doesNotMatch(click({ x: expandedPoint.x + offset, y: expandedPoint.y }), detail,
        "the expanded disclosure keeps its padded target");
    }
    for (const offset of [-3, 3]) {
      const point = arrows()[index];
      assert.doesNotMatch(click({ x: point.x + offset, y: point.y }), detail, "outside the padded target stays inert");
    }
  }
  let expanded = click(arrows()[0]);
  assert.match(expanded, /~\/project\/harness\/metis-pi \(fix\/output-speed-accounting\)/);
  assert.doesNotMatch(expanded, /turns queued/);
  assert.equal(editor.focused, true);
  expanded = click(arrows()[1]);
  assert.ok(expanded.includes(queued));
  assert.ok(expanded.includes(`${summary} ▼`));
  assert.ok(scroll.viewportHeight < initialViewport, "disclosures resize the transcript instead of covering it");
  assert.equal(tui.getPrimaryScrollView(), scroll);
  assert.equal(tui.hasOverlay(), false);
  assert.match(expanded, /Other status stays/);
  const goalPoint = () => ({ x: 2, y: screenLines(tui).findIndex(line => line.includes("goal") || line.includes("Goal complete")) + 1 });
  click(goalPoint());
  assert.equal(goalOpens, 1, "native footer clicks open the goal without changing composer focus");
  assert.equal(editor.focused, true);
  statuses.set("goal", "Goal complete");
  frame();
  const oldGoal = goalPoint();
  click(oldGoal);
  assert.equal(goalOpens, 2, "inactive goal statuses remain clickable");
  statuses.delete("goal");
  frame();
  click(oldGoal);
  assert.equal(goalOpens, 2, "removed status geometry cannot open a stale goal");
  const bodyRow = screenLines(tui).findIndex(line => line.includes("turns queued")) + 1;
  assert.match(click({ x: 3, y: bodyRow }), /turns queued/, "detail content is not a disclosure target");

  branch = "topic-分支";
  callbacks.forEach(cb => cb());
  assert.match(frame(), /topic-分支/);
  statuses.set("context-prune", `${summary}\n8 turns queued — updated detail`);
  assert.match(frame(), /8 turns queued/, "an expanded detail follows the latest status without collapsing");
  const point = arrows()[0];
  tui.handleTerminalInput(sgr(0, point.x, point.y));
  tui.handleTerminalInput(sgr(32, point.x + 1, point.y));
  tui.handleTerminalInput(sgr(0, point.x + 1, point.y, true));
  assert.match(frame(), /topic-分支/, "dragging the arrow must not toggle it");
  terminal.columns = 48;
  frame();
  assert.ok(tui.previousScreen.every(line => Tui.visibleWidth(line) <= 48));
  const resizedPoint = arrows()[0];
  assert.doesNotMatch(click({ x: resizedPoint.x - 2, y: resizedPoint.y }), /topic-分支/);
  assert.match(frame(), /8 turns queued/, "folding location leaves prune expanded after resize");
  assert.equal(editor.focused, true);
  assert.ok(renders > 0);
  assert.ok(footer.render(160)[0].includes("+99 -10"), "changes stay visible when location is hidden");
  const fresh = createFooterComponent(deps, data, text => text);
  assert.doesNotMatch(fresh.render(160).join("\n"), /topic-分支|turns queued/);
  fresh.dispose();
  footer.dispose();
  assert.equal(callbacks.size, 0, "each branch subscription is released");
  const initiallyExpanded = { location: true, prune: true };
  const configured = createFooterComponent({ ...deps, initiallyExpanded }, data, text => text);
  tui.setLayoutRoot(configured);
  assert.match(frame(), /topic-分支/);
  assert.match(frame(), /8 turns queued/);
  assert.doesNotMatch(click(arrows()[0]), /topic-分支/, "click overrides the configured default for this view");
  assert.match(frame(), /8 turns queued/);
  assert.deepEqual(initiallyExpanded, { location: true, prune: true }, "click does not mutate configuration");
  configured.dispose();
  assert.equal(callbacks.size, 0);
});
