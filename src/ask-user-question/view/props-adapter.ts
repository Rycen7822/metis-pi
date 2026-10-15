import type { Editor } from "@earendil-works/pi-tui";
import {
	selectActivePreviewPaneIndex, selectConfirmedIndicator, selectCustomDraftValue, selectSavedNote,
} from "../state/selectors/derivations.ts";
import { selectActiveView } from "../state/selectors/focus.ts";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionRow } from "../state/row-intent.ts";
import type { QuestionData } from "../tool/types.ts";
import { displayLabel, t } from "../state/i18n-bridge.ts";
import { MULTI_SUBMIT_LABEL } from "./components/multi-select-view.ts";
import type { SubmitPickerProps } from "./components/submit-picker.ts";
import type { TabBarProps } from "./components/tab-bar.ts";
import type { DialogProps } from "./dialog-builder.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";

interface PropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly QuestionRow[]>;
	tabsByIndex: readonly TabComponents[];
	inlineInput: Editor;
	notesInput: Editor;
	dialog: StatefulView<DialogProps>;
	tabBar?: StatefulView<TabBarProps>;
	submitPicker?: StatefulView<SubmitPickerProps>;
}

function inputCursorOffset(input: Editor): number {
	const lines = input.getLines();
	const cursor = input.getCursor();
	let offset = cursor.col;
	for (let i = 0; i < cursor.line; i++) offset += (lines[i]?.length ?? 0) + 1;
	return offset;
}

/** The fixed component graph owns its projection and invalidation. */
export function createPropsAdapter(config: PropsAdapterConfig) {
	const { tui, questions, itemsByTab, tabsByIndex, inlineInput, notesInput, dialog, tabBar, submitPicker } = config;
	return {
		apply(state: QuestionnaireState): void {
			const active = selectActiveView(state, questions.length);
			const focused = active === "options";
			const paneIndex = selectActivePreviewPaneIndex(state.currentTab, questions.length);
			const tab = tabsByIndex[paneIndex]!;
			const inputBuffer = inlineInput.getText();
			const cursor = inputCursorOffset(inlineInput);
			dialog.setProps({ state, activePreviewPane: tab.preview });
			submitPicker?.setProps({
				rows: [
					{ active: active === "submit" && state.submitChoiceIndex === 0 },
					{ active: active === "submit" && state.submitChoiceIndex === 1 },
				],
			});
			tabBar?.setProps({
				tabs: questions.map((q, i) => ({
					label: q.header || `Q${i + 1}`,
					answered: state.answers.has(i),
					active: i === state.currentTab,
				})),
				submit: {
					active: state.currentTab === questions.length,
					allAnswered: state.answers.size === questions.length && questions.length > 0,
				},
			});
			const confirmed = selectConfirmedIndicator(questions, state.currentTab, state.answers, itemsByTab[paneIndex] ?? []);
			tab.optionList.setProps({
				selectedIndex: state.optionIndex, focused, inputBuffer, inputCursorOffset: cursor,
				...(confirmed ? { confirmed } : {}),
			});
			tab.preview.setProps({
				notesVisible: state.notesVisible,
				hasNote: selectSavedNote(state.notesByTab, state.answers, paneIndex) !== undefined,
				selectedIndex: state.optionIndex, focused, inputMode: state.inputMode,
			});
			// All multi views participate in the cross-tab height measurement.
			for (let i = 0; i < tabsByIndex.length; i++) {
				const q = questions[i]!;
				const isCurrent = i === state.currentTab;
				const tabFocused = focused && isCurrent;
				const draft = isCurrent ? inputBuffer : selectCustomDraftValue(state, i);
				const selected = state.answers.get(i)?.selected ?? [];
				tabsByIndex[i]!.multiSelect?.setProps({
					rows: q.options.map((option, index) => ({
						checked: isCurrent ? state.multiSelectChecked.has(index) : selected.includes(option.label),
						active: tabFocused && index === state.optionIndex,
					})),
					other: {
						active: tabFocused && state.optionIndex === q.options.length,
						checked: draft.trim().length > 0,
						inputMode: isCurrent && state.inputMode, inputBuffer: draft, inputCursorOffset: isCurrent ? cursor : undefined,
					},
					nextActive: tabFocused && state.optionIndex === q.options.length + 1,
					nextLabel: i === questions.length - 1 ? t("submit.label", MULTI_SUBMIT_LABEL) : displayLabel("next"),
				});
			}
			tui.requestRender();
		},
		invalidate(): void {
			dialog.invalidate();
			tabBar?.invalidate();
			submitPicker?.invalidate();
			for (const tab of tabsByIndex) {
				tab.preview.invalidate();
				tab.multiSelect?.invalidate();
			}
			notesInput.invalidate();
		},
	};
}
