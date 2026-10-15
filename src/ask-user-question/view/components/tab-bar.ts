import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../../state/i18n-bridge.ts";
import type { StatefulView } from "../stateful-view.ts";

/**
 * Per-tick projection of TabBar state. The selector
 * (`selectTabBarProps`) hoists every render-time derivation
 * (`allAnswered`, `answered`, `isActive`, `submitActive`) into props so
 * `render()` is pure styling.
 */
export interface TabBarProps {
	/** One per author-defined question, in order. */
	tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
	/** Submit-tab state. `allAnswered` drives the success/dim color picker. */
	submit: { active: boolean; allAnswered: boolean };
}

export class TabBar implements StatefulView<TabBarProps> {
	private props: TabBarProps;

	constructor(private readonly theme: Theme) {
		this.props = { tabs: [], submit: { active: false, allAnswered: false } };
	}

	setProps(props: TabBarProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const pieces: string[] = [];

		for (const tab of this.props.tabs) {
			const box = tab.answered ? "■" : "□";
			const rawSeg = ` ${box} ${tab.label.replace(/[\r\n]+/g, " ")} `;
			const styled = tab.active
				? this.theme.bg("selectedBg", this.theme.fg("text", rawSeg))
				: this.theme.fg(tab.answered ? "success" : "muted", rawSeg);
			pieces.push(styled);
		}

		const submitText = ` ✓ ${t("submit.label", "Submit")} `;
		const submitStyled = this.props.submit.active
			? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
			: this.theme.fg(this.props.submit.allAnswered ? "success" : "dim", submitText);
		pieces.push(submitStyled);

		const active = this.props.submit.active
			? pieces.length - 1
			: Math.max(0, this.props.tabs.findIndex(tab => tab.active));
		let start = 0;
		let end = pieces.length;
		// Drop the farthest tab first, retaining the active tab and its nearest neighbors.
		while (end - start > 1 && visibleWidth(pieces.slice(start, end).join(" ")) + 5 > width) {
			if (active - start > end - 1 - active) start++;
			else end--;
		}
		const tabLine = truncateToWidth(` ← ${pieces.slice(start, end).join(" ")} →`, width, "");
		return [tabLine, ""];
	}
}
