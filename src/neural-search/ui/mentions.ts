import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { SearchRuntime } from "../session.ts";

export function createMentionWrapper(runtime: SearchRuntime): (current: AutocompleteProvider) => AutocompleteProvider {
  return current => ({
    get triggerCharacters() { return current.triggerCharacters; },
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/)?.[1];
      if (prefix && !options.signal.aborted) {
        try {
          const scope = runtime.current();
          const finder = await runtime.ensureMain(scope, options.signal);
          runtime.assertCurrent(scope);
          if (options.signal.aborted) return null;
          const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
          const result = finder.mixedSearch(query, { pageSize: 20 });
          if (result.ok && result.value.items.length) {
            const items: AutocompleteItem[] = result.value.items.slice(0, 20).map(mixed => {
              const item = mixed.item;
              return {
                value: item.relativePath.includes(" ") ? `@"${item.relativePath}"` : `@${item.relativePath}`,
                label: mixed.type === "directory" ? mixed.item.dirName : mixed.item.fileName,
                description: item.relativePath,
              };
            });
            return { items, prefix };
          }
        } catch { /* Preserve the host's completions when the index is unavailable. */ }
      }
      return options.signal.aborted ? null : current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  });
}
