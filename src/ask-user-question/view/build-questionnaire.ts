import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { QuestionData } from "../tool/types.ts";
import type { QuestionRow } from "../state/row-intent.ts";
import type { QuestionnaireState } from "../state/state.ts";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.ts";
import { MultiSelectView } from "./components/multi-select-view.ts";
import { OptionListView } from "./components/option-list-view.ts";
import { PreviewBlockRenderer } from "./components/preview/preview-block-renderer.ts";
import { crossTabLeftWidthWithDonation } from "./components/preview/preview-layout-decider.ts";
import { PreviewPane } from "./components/preview/preview-pane.ts";
import { SubmitPicker } from "./components/submit-picker.ts";
import { TabBar } from "./components/tab-bar.ts";
import { DialogView } from "./dialog-builder.ts";
import { createPropsAdapter } from "./props-adapter.ts";
import type { TabComponents } from "./tab-components.ts";

export interface QuestionnaireBuildConfig {
	tui: TUI;
	theme: Theme;
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly QuestionRow[]>;
	isMulti: boolean;
	initialState: QuestionnaireState;
	collapseKey: string;
	/** Host-specific viewport budget; the dialog keeps the same overflow policy. */
	rowBudget: (terminalRows: number) => number;
}

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: {
			selectedPrefix: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
			selectedText: (text) => theme.bg("selectedBg", theme.bold(text)),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

export function buildQuestionnaire(config: QuestionnaireBuildConfig) {
	const { tui, theme, questions, itemsByTab, isMulti, collapseKey, rowBudget } = config;
	let state = config.initialState;
	const notesInput = new Editor(tui, editorTheme(theme));
	const inlineInput = new Editor(tui, editorTheme(theme));
	// The router consumes submission; these Editors own only text and cursor operations.
	notesInput.disableSubmit = true;
	inlineInput.disableSubmit = true;
	const selectTheme = {
		selectedText: (text: string) => theme.fg("accent", theme.bold(text)),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
	};
	const markdownTheme = getMarkdownTheme();
	const globalLeftWidth = (width: number) => crossTabLeftWidthWithDonation(questions, itemsByTab, questions, width);
	const tabs: TabComponents[] = questions.map((question, index) => {
		const optionList = new OptionListView({ items: itemsByTab[index] ?? [], theme: selectTheme });
		const previewBlock = new PreviewBlockRenderer({ question, theme, markdownTheme });
		const preview = new PreviewPane({
			question,
			theme,
			getTerminalWidth: () => tui.terminal.columns,
			optionListView: optionList,
			previewBlock,
			getGlobalLeftWidth: globalLeftWidth,
		});
		const multiSelect = question.multiSelect ? new MultiSelectView(theme, question) : undefined;
		return {
			optionList, preview, multiSelect,
			bodyHeights: (width) => {
				const current = multiSelect ? multiSelect.naturalHeight(width) : preview.naturalHeight(width);
				return { current, max: multiSelect ? current : Math.max(current, preview.maxNaturalHeight(width)) };
			},
		};
	});
	const submitPicker = isMulti ? new SubmitPicker(theme) : undefined;
	const tabBar = isMulti ? new TabBar(theme) : undefined;
	const paneIndex = selectActivePreviewPaneIndex(state.currentTab, questions.length);
	const dialog = new DialogView({
		theme, questions, tabBar, notesInput, isMulti, tabsByIndex: tabs, submitPicker, collapseKey,
		getBodyHeight: (width) => Math.max(1, ...tabs.map((tab) => tab.bodyHeights(width).max)),
		getCurrentBodyHeight: (width) => Math.max(0,
			tabs[Math.min(state.currentTab, tabs.length - 1)]?.bodyHeights(width).current ?? 0),
		getTerminalRows: () => rowBudget(tui.terminal.rows),
	}, { state, activePreviewPane: tabs[paneIndex]!.preview });
	const adapter = createPropsAdapter({
		tui, questions, itemsByTab, tabsByIndex: tabs,
		inlineInput, notesInput, dialog, tabBar, submitPicker,
	});
	return {
		notesInput, inlineInput,
		apply(next: QuestionnaireState): void {
			state = next;
			adapter.apply(next);
		},
		render: (width: number) => dialog.render(width),
		scrollReview: (direction: -1 | 1) => dialog.scrollReview(direction),
		invalidate: adapter.invalidate,
	};
}

export type QuestionnaireBuilt = ReturnType<typeof buildQuestionnaire>;
