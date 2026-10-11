import { Theme } from "@earendil-works/pi-coding-agent";

export const makeSubagentTheme = (mode = "truecolor") => new Theme({
  accent: "#338bdc", muted: "#777777", dim: "#666666",
  warning: "#ffcc00", text: "#cccccc", thinkingXhigh: "#338bdc",
}, { selectedBg: "#101010" }, mode);

export const subagentTheme = makeSubagentTheme();
