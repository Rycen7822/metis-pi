import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Top + bottom border rows consumed by `renderBorderedBox`. */
export const BORDER_VERTICAL_OVERHEAD = 2;
/** Left + right vertical bar columns (`│ ... │`) consumed by `renderBorderedBox`. */
export const BORDER_HORIZONTAL_OVERHEAD = 2;
/** Inner horizontal padding (1 col) between each border bar and content area. */
export const BORDER_INNER_PADDING_HORIZONTAL = 1;
/** Floor for the preview box's inner content width — CC parity (`PreviewBox.minWidth`). */
export const BOX_MIN_CONTENT_WIDTH = 40;
export const MIN_BOX_WIDTH = BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL + 1;

/**
 * Wraps `lines` in a 4-sided ASCII border with 1 col of inner horizontal padding.
 * Layout per content row: `│` + ` ` + content padded to `contentInner` + ` ` + `│`,
 * where `contentInner = width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL`.
 * Top/bottom dash runs span corner-to-corner (`width - BORDER_HORIZONTAL_OVERHEAD`). When
 * `hidden > 0`, the bottom-row dash run is replaced with ` ✂ ── N lines hidden ── ` (corners stay).
 */
export function renderBorderedBox(
	lines: readonly string[],
	width: number,
	colorFn: (s: string) => string,
	hidden = 0,
): string[] {
	if (width < MIN_BOX_WIDTH) return [];
	const dashSpan = width - BORDER_HORIZONTAL_OVERHEAD;
	const contentInner = Math.max(1, dashSpan - 2 * BORDER_INNER_PADDING_HORIZONTAL);
	const pad = " ".repeat(BORDER_INNER_PADDING_HORIZONTAL);
	const top = colorFn(`┌${"─".repeat(dashSpan)}┐`);
	const out: string[] = [top];
	for (const line of lines) {
		const padded = truncateToWidth(line, contentInner, "", true);
		out.push(`${colorFn("│")}${pad}${padded}${pad}${colorFn("│")}`);
	}
	let indicator = hidden > 0 ? ` ✂ ── ${hidden} lines hidden ── ` : "";
	if (visibleWidth(indicator) > dashSpan) indicator = String(hidden);
	indicator = truncateToWidth(indicator, dashSpan, "");
	const space = dashSpan - visibleWidth(indicator);
	const left = "─".repeat(Math.floor(space / 2));
	const right = "─".repeat(Math.ceil(space / 2));
	out.push(colorFn(`└${left}${indicator}${right}┘`));
	return out;
}

/**
 * Compute box dimensions from content lines. Pure of args.
 *
 * CC parity:
 *   contentWidth = max(minWidth, widestRenderedLine)
 *   boxWidth     = min(contentWidth + 4, effectiveMaxWidth)
 *
 * Trailing whitespace is stripped before measuring because pi-tui's
 * `Markdown.render(width)` pads every line to `width`, which would otherwise force
 * the box to fill the whole column allocation.
 */
export function computeBoxDimensions(
	contentLines: readonly string[],
	maxInnerWidth: number,
): { innerWidth: number; boxWidth: number } {
	let widest = Math.min(BOX_MIN_CONTENT_WIDTH, maxInnerWidth);
	for (const line of contentLines) {
		const w = visibleWidth(line.replace(/\s+$/, ""));
		if (w > widest) widest = w;
	}
	const innerWidth = Math.min(widest, maxInnerWidth);
	const boxWidth = innerWidth + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL;
	return { innerWidth, boxWidth };
}
