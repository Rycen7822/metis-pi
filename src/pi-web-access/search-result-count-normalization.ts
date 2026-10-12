export function normalizeSearchResultCount(value: number | undefined, options: { max?: number } = {}): number {
	const count = typeof value === "number" && Number.isFinite(value) ? value : 5;
	return Math.max(1, Math.min(Math.floor(count), options.max ?? 20));
}
