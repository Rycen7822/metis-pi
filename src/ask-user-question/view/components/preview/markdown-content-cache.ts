import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../../../state/i18n-bridge.ts";
import type { QuestionData } from "../../../tool/types.ts";

export const NO_PREVIEW_TEXT = "No preview available";

/** Remove Markdown code-fence rows while preserving highlighted code and inline code. */
export function stripFenceMarkers(lines: readonly string[]): string[] {
	return lines.filter((line) => !/^`{3}/.test(stripTerminalSequences(line)));
}

/** One lazily constructed Markdown per option; Markdown owns its width cache. */
export class MarkdownContentCache {
	private readonly previewTexts: Map<number, string>;
	private readonly markdownCache: Map<number, Markdown>;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;

	constructor(question: QuestionData, theme: Theme, markdownTheme: MarkdownTheme) {
		this.theme = theme;
		this.markdownTheme = markdownTheme;
		this.previewTexts = new Map();
		for (let i = 0; i < question.options.length; i++) {
			const raw = question.options[i]?.preview;
			if (raw && raw.length > 0) this.previewTexts.set(i, raw);
		}
		this.markdownCache = new Map();
	}

	hasAnyPreview(): boolean {
		return this.previewTexts.size > 0;
	}

	has(optionIndex: number): boolean {
		return this.previewTexts.has(optionIndex);
	}

	bodyFor(optionIndex: number, innerWidth: number): string[] {
		const text = this.previewTexts.get(optionIndex);
		if (!text) {
			const placeholder = this.theme.fg("dim", t("preview.no_preview", NO_PREVIEW_TEXT));
			const pad = Math.max(0, innerWidth - visibleWidth(placeholder));
			return [placeholder + " ".repeat(pad)];
		}
		let md = this.markdownCache.get(optionIndex);
		if (!md) {
			md = new Markdown(text, 0, 0, this.markdownTheme);
			this.markdownCache.set(optionIndex, md);
		}
		return stripFenceMarkers(md.render(innerWidth));
	}

	invalidate(): void {
		for (const md of this.markdownCache.values()) md.invalidate();
	}
}
