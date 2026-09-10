
import { makeRenderers } from "./src/renderers.ts";
import { readFileSync } from "node:fs";
const palette = JSON.parse(readFileSync("themes/codex-appearance.json", "utf8"));
const theme = { fg: (k, t) => t, bold: (t) => t };
const makeText = (text) => ({ text, render: (w) => text.split("\n").map(l => l.slice(0, w)), setText: (n) => { text = n; } });
const renderers = makeRenderers(makeText, () => "hint", null, null, null, { colorLevel: { kind: "truecolor" } });
const args = { command: "npm run check" };
const call = renderers.bash.renderCall(args, theme, { args, state: {}, isPartial: true });
console.log("CALL LINES:", JSON.stringify(call.render(112), null, 1));
const res = renderers.bash.renderResult({ content: [{ type: "text", text: "Checking..." }] }, { expanded: false }, theme, { args, state: {}, isPartial: true });
console.log("RESULT:", JSON.stringify(res ? res.render(112) : null));
