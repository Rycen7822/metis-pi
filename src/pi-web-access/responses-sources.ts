type Citation = { url?: unknown; title?: unknown; start_index?: unknown; end_index?: unknown };

export function forEachCitationAnnotation(output: readonly unknown[], add: (citation: Citation, text: string) => void): void {
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
			const annotations = (part as { annotations?: unknown }).annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
				add(annotation as Citation, text);
			}
		}
	}
}

export function forEachSearchCallSource(output: readonly unknown[], callTypes: readonly string[], add: (source: unknown) => void): void {
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const type = (item as { type?: unknown }).type;
		if (typeof type !== "string" || !callTypes.includes(type)) continue;
		const value = item as { action?: unknown; sources?: unknown; results?: unknown };
		const actionSources = value.action && typeof value.action === "object"
			? (value.action as { sources?: unknown }).sources : undefined;
		for (const group of [actionSources, value.sources, value.results]) {
			if (Array.isArray(group)) for (const source of group) add(source);
		}
	}
}
