import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { SearchRuntime } from "../session.ts";

export function createMentionWrapper(runtime: SearchRuntime, isActive: () => boolean = () => true): (current: AutocompleteProvider) => AutocompleteProvider {
  return current => ({
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.signal.aborted) return null;
      const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/)?.[1];
      const quoted = prefix?.startsWith('@"');
      const query = prefix?.slice(quoted ? 2 : 1) ?? "";
      // Path navigation belongs to the host, including its cwd and quoting rules.
      // Do not open the main index just to discard its unscoped fuzzy results.
      const navigation = /[\\/]/.test(query) || /^(?:\.{1,2}|~)$/.test(query) || /^[A-Za-z]:/.test(query);
      if (isActive() && prefix && !navigation) {
        try {
          const scope = runtime.current();
          const finder = await runtime.ensureMain(scope, options.signal);
          runtime.assertCurrent(scope);
          if (options.signal.aborted) return null;
          if (!isActive()) return current.getSuggestions(lines, cursorLine, cursorCol, options);
          const result = finder.mixedSearch(query, { pageSize: 20 });
          if (result.ok && result.value.items.length) {
            const items: AutocompleteItem[] = result.value.items.slice(0, 20).map(mixed => {
              const item = mixed.item;
              return {
                value: quoted || item.relativePath.includes(" ") ? `@"${item.relativePath}"` : `@${item.relativePath}`,
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
