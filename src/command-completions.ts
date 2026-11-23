import type { AutocompleteItem } from "@earendil-works/pi-tui";

export function commandChoices(source: readonly string[] | ((prefix: string) => readonly string[])) {
  return (input: string): AutocompleteItem[] => {
    const prefix = input.trimStart();
    const values = typeof source === "function" ? source(prefix) : source;
    return values.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
  };
}
