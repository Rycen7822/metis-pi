import { Box, Text, TruncatedText, type Component } from "@earendil-works/pi-tui";

/** Inset content by two columns on every visual row, including wrapped continuations. */
export function webToolBody(component: Component): Box {
	const box = new Box(2, 0);
	box.addChild(component);
	return box;
}

export function webToolCall(title: string, details: string[]): Box {
	const box = new Box(0, 0);
	// Clip only the short title here; detail rows keep their own formatting and wrapping.
	box.addChild(new TruncatedText(title, 0, 0));
	if (details.length) box.addChild(webToolBody(new Text(details.join("\n"), 0, 0)));
	return box;
}
