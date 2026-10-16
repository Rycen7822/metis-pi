import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Editor } from "@earendil-works/pi-tui";
import { makeQuestion, makeQuestionnaireState } from "../../../src/ask-user-question/test-fixtures.ts";
import type { QuestionData } from "../../../src/ask-user-question/tool/types.ts";
import type { MultiSelectView } from "../../../src/ask-user-question/view/components/multi-select-view.ts";
import type { OptionListView } from "../../../src/ask-user-question/view/components/option-list-view.ts";
import type { PreviewPane } from "../../../src/ask-user-question/view/components/preview/preview-pane.ts";
import type { TabBar } from "../../../src/ask-user-question/view/components/tab-bar.ts";
import {
	type DialogConfig, type DialogProps, type DialogState, DialogView,
} from "../../../src/ask-user-question/view/dialog-builder.ts";
import type { TabComponents } from "../../../src/ask-user-question/view/tab-components.ts";
import { makeTheme } from "./theme.ts";

export const HINT_SINGLE = "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel";
export const HINT_MULTI = "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel";
export const HINT_PART_COLLAPSE = "Ctrl+] to collapse";

const theme = makeTheme() as unknown as Theme;

export function stubComponent(lines: string[]): Component {
	return { render: () => lines, handleInput() {}, invalidate() {} };
}

export function stubPreviewPane(lines: string[], rowRange?: (w: number) => [number, number]): PreviewPane {
	return {
		...stubComponent(lines),
		focusedItemRowRange: rowRange ?? (() => [0, 1] as [number, number]),
	} as unknown as PreviewPane;
}

export type DialogOverrides = Partial<Omit<DialogConfig, "tabsByIndex">> & {
	state?: DialogState;
	previewPane?: PreviewPane;
	initialProps?: DialogProps;
	tabsByIndex?: ReadonlyArray<TabComponents>;
	multiSelectByTab?: ReadonlyArray<MultiSelectView | undefined>;
};

interface DialogParts {
	config: DialogConfig;
	initialProps: DialogProps;
}

export function makeDialogConfig(over: DialogOverrides = {}): DialogParts {
	const questions: QuestionData[] = over.questions ? [...over.questions] : [
		makeQuestion({ question: "Q1?", header: "H1" }),
		makeQuestion({ question: "Q2?", header: "H2", options: [
			{ label: "X", description: "x" }, { label: "Y", description: "y" },
		] }),
	];
	const state = over.state ?? makeQuestionnaireState();
	const previewPane = over.previewPane ?? stubPreviewPane(["<PREVIEW>"]);
	const tabsByIndex = over.tabsByIndex ?? questions.map((_, i) => ({
		optionList: stubComponent(["<OPTION_LIST>"]) as unknown as OptionListView,
		preview: previewPane,
		multiSelect: over.multiSelectByTab?.[i],
		bodyHeights: () => ({ current: 0, max: 0 }),
	}));
	const config: DialogConfig = {
		theme: over.theme ?? theme,
		questions,
		tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Editor),
		isMulti: over.isMulti ?? questions.length > 1,
		tabsByIndex,
		submitPicker: over.submitPicker,
		getBodyHeight: over.getBodyHeight ?? (() => 1),
		getCurrentBodyHeight: over.getCurrentBodyHeight ?? ((width) => {
			const current = state.currentTab;
			const multiSelect = tabsByIndex[current]?.multiSelect;
			return questions[current]?.multiSelect && multiSelect
				? multiSelect.render(width).length : previewPane.render(width).length;
		}),
		getTerminalRows: over.getTerminalRows ?? (() => 24),
		collapseKey: over.collapseKey ?? "ctrl+]",
	};
	return { config, initialProps: over.initialProps ?? { state, activePreviewPane: previewPane } };
}

export function makeDialog(parts: DialogParts): DialogView {
	return new DialogView(parts.config, parts.initialProps);
}
