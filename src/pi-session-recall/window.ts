import type { QueryInputBudget } from "./input-budget.ts";

export const WINDOW_SEPARATOR = "\n\n";

function omitted(count: number): string {
	return `[... ${count} messages omitted ...]`;
}

interface Excerpt {
	text: string;
	cost: number;
}

/** Entries and gaps start with '['; the footer starts with '#'. Their left-hand separator makes their costs additive. */
export function createWindow(total: number, budget: number, measure: QueryInputBudget["measure"]) {
	const entries: Array<Excerpt & { index: number }> = [];
	const gapCosts = new Map<number, number>();
	function gapCost(count: number): number {
		if (count === 0) return 0;
		const cached = gapCosts.get(count);
		if (cached !== undefined) return cached;
		const cost = measure(omitted(count) + WINDOW_SEPARATOR);
		gapCosts.set(count, cost);
		return cost;
	}
	let remaining = budget - gapCost(total);
	return {
		at(index: number) {
			let start = 0, end = entries.length;
			while (start < end) {
				const mid = Math.floor((start + end) / 2);
				if (entries[mid]!.index < index) start = mid + 1;
				else end = mid;
			}
			const replaced = entries[start]?.index === index ? entries[start] : undefined;
			let available = remaining;
			if (replaced) {
				available += replaced.cost;
			} else {
				// Inserting in a gap removes its old marker and introduces up to two smaller ones.
				const before = entries[start - 1]?.index ?? -1;
				const after = entries[start]?.index ?? total;
				available += gapCost(after - before - 1) - gapCost(index - before - 1) - gapCost(after - index - 1);
			}
			return {
				available,
				replacing: replaced !== undefined,
				// Consumed at most once, before looking up another position.
				put(excerpt: Excerpt) {
					entries.splice(start, replaced ? 1 : 0, { index, ...excerpt });
					remaining = available - excerpt.cost;
				},
			};
		},
		render() {
			const parts: string[] = [];
			let next = 0;
			for (const entry of entries) {
				if (entry.index > next) parts.push(omitted(entry.index - next));
				parts.push(entry.text);
				next = entry.index + 1;
			}
			if (next < total) parts.push(omitted(total - next));
			return parts.join(WINDOW_SEPARATOR);
		},
	};
}
