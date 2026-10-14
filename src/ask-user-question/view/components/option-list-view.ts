import { CURSOR_MARKER, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { QuestionRow } from "../../state/row-intent.ts";
import type { StatefulView } from "../stateful-view.ts";
import { renderInlineInputRow } from "./inline-input.ts";

export const MAX_VISIBLE_OPTIONS = 10;

export interface OptionListTheme {
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
}

export interface OptionListViewConfig {
	items: readonly QuestionRow[];
	theme: OptionListTheme;
	maxVisible?: number;
}

export interface OptionListViewProps {
	selectedIndex: number;
	focused: boolean;
	inputBuffer: string;
	inputCursorOffset?: number;
	confirmed?: { index: number; labelOverride?: string };
}

export class OptionListView implements StatefulView<OptionListViewProps> {
	private static readonly ACTIVE_POINTER = "❯ ";
	private static readonly INACTIVE_POINTER = "  ";
	private static readonly NUMBER_SEPARATOR = ". ";
	private static readonly CONFIRMED_MARK = " ✔";
	private static readonly MIN_CONTENT_WIDTH = 1;

	private readonly items: readonly QuestionRow[];
	private readonly maxVisible: number;
	private readonly theme: OptionListTheme;
	private props: OptionListViewProps = { selectedIndex: 0, focused: true, inputBuffer: "" };

	constructor(config: OptionListViewConfig) {
		this.items = config.items;
		this.maxVisible = Math.max(1, config.maxVisible ?? Math.min(config.items.length, MAX_VISIBLE_OPTIONS));
		this.theme = config.theme;
	}

	setProps(props: OptionListViewProps): void {
		const clamp = (index: number) => Math.max(0, Math.min(index, this.items.length - 1));
		this.props = {
			...props,
			selectedIndex: clamp(props.selectedIndex),
			...(props.confirmed ? { confirmed: { ...props.confirmed, index: clamp(props.confirmed.index) } } : {}),
		};
	}

	/** Intentionally empty — input is routed at the container level. */
	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.items.length === 0) return [];

		const { startIndex, endIndex } = this.computeVisibleWindow();
		const numberWidth = String(Math.max(1, this.items.length)).length;
		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isActive = i === this.props.selectedIndex && this.props.focused;
			lines.push(...this.renderItem(item, i, isActive, width, numberWidth));
		}

		if (this.hasItemsOutsideWindow(startIndex, endIndex)) {
			lines.push(this.theme.scrollInfo(`  (${this.props.selectedIndex + 1}/${this.items.length})`));
		}
		return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
	}

	/**
	 * Returns the [startRow, endRow) range of the focused (selected) item within
	 * the output of `render(width)`. Computed by iterating the visible window and
	 * summing per-item row counts — O(maxVisible) per call.
	 */
	focusedItemRowRange(width: number): [number, number] {
		if (this.items.length === 0) return [0, 0];
		const { startIndex, endIndex } = this.computeVisibleWindow();
		const numberWidth = String(Math.max(1, this.items.length)).length;
		let row = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isActive = i === this.props.selectedIndex && this.props.focused;
			const itemRows = this.renderItem(item, i, isActive, width, numberWidth);
			const itemRowCount = itemRows.length;
			if (i === this.props.selectedIndex) {
				const caret = item.kind === "other" && isActive ? itemRows.findIndex((line) => line.includes(CURSOR_MARKER)) : -1;
				return caret >= 0 ? [row + caret, row + caret + 1] : [row, row + itemRowCount];
			}
			row += itemRowCount;
		}
		return [0, 1];
	}

	private computeVisibleWindow(): { startIndex: number; endIndex: number } {
		const half = Math.floor(this.maxVisible / 2);
		const startIndex = Math.max(0, Math.min(this.props.selectedIndex - half, this.items.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
		return { startIndex, endIndex };
	}

	private hasItemsOutsideWindow(startIndex: number, endIndex: number): boolean {
		return startIndex > 0 || endIndex < this.items.length;
	}

	private renderItem(
		item: QuestionRow,
		index: number,
		isActive: boolean,
		width: number,
		numberWidth: number,
	): string[] {
		const rowPrefix = truncateToWidth(this.buildRowPrefix(index, isActive, numberWidth), Math.max(0, width - 1), "");
		const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
		const contentWidth = Math.max(OptionListView.MIN_CONTENT_WIDTH, width - visibleWidth(rowPrefix));

		if (this.shouldRenderAsInlineInput(item, isActive)) {
			return this.renderInlineInputRow(rowPrefix, continuationPrefix, contentWidth);
		}

		const { label, isConfirmed } = this.deriveConfirmedState(item, index);
		const applySelectedStyle = isActive || isConfirmed;

		return [
			...this.renderLabelBlock(label, rowPrefix, continuationPrefix, contentWidth, applySelectedStyle),
			...this.renderDescriptionBlock(item.description, continuationPrefix, contentWidth),
		];
	}

	/**
	 * Derive the confirmed-rendering facts for one row: the final label (custom draft
	 * or confirmed-override aware) and whether the ✔ mark applies.
	 */
	private deriveConfirmedState(item: QuestionRow, index: number): { label: string; isConfirmed: boolean } {
		// Keep an in-flight custom draft visible even while the cursor browses another row.
		// If it differs from a previously confirmed custom answer, omit the confirmation
		// mark so the pending draft is not presented as committed.
		const customDraft = item.kind === "other" ? this.props.inputBuffer : undefined;
		const customDraftDiffersFromConfirmed =
			item.kind === "other" &&
			customDraft !== "" &&
			index === this.props.confirmed?.index &&
			customDraft !== (this.props.confirmed?.labelOverride ?? "");
		const isConfirmed = index === this.props.confirmed?.index && !customDraftDiffersFromConfirmed;
		const baseLabel = customDraft ? customDraft : item.label;
		const label = isConfirmed
			? `${this.props.confirmed?.labelOverride ?? baseLabel}${OptionListView.CONFIRMED_MARK}`
			: baseLabel;
		return { label, isConfirmed };
	}

	private buildRowPrefix(index: number, isActive: boolean, numberWidth: number): string {
		const pointer = isActive ? OptionListView.ACTIVE_POINTER : OptionListView.INACTIVE_POINTER;
		const displayNumber = index + 1;
		const paddedNumber = String(displayNumber).padStart(numberWidth, " ");
		return `${pointer}${paddedNumber}${OptionListView.NUMBER_SEPARATOR}`;
	}

	private shouldRenderAsInlineInput(item: QuestionRow, isActive: boolean): boolean {
		return item.kind === "other" && isActive;
	}

	/** Render the inline editor across logical and visually wrapped lines. */
	private renderInlineInputRow(rowPrefix: string, continuationPrefix: string, contentWidth: number): string[] {
		return renderInlineInputRow({
			buffer: this.props.inputBuffer,
			cursorOffset: this.props.inputCursorOffset,
			rowPrefix,
			continuationPrefix,
			contentWidth,
			selectedText: this.theme.selectedText,
		});
	}

	private renderLabelBlock(
		label: string,
		rowPrefix: string,
		continuationPrefix: string,
		contentWidth: number,
		applySelectedStyle: boolean,
	): string[] {
		const wrapped = wrapTextWithAnsi(label, contentWidth);
		return wrapped.map((segment, index) => {
			const prefix = index === 0 ? rowPrefix : continuationPrefix;
			const line = `${prefix}${segment}`;
			return applySelectedStyle ? this.theme.selectedText(line) : line;
		});
	}

	private renderDescriptionBlock(
		description: string | undefined,
		continuationPrefix: string,
		contentWidth: number,
	): string[] {
		if (!description) return [];
		const wrapped = wrapTextWithAnsi(description, contentWidth);
		return wrapped.map((segment) => `${continuationPrefix}${this.theme.description(segment)}`);
	}
}
