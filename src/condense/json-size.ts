// Cache only long strings' escaped lengths. The budget counts source UTF-16 code units,
// not JS heap bytes; it limits dynamic-text retention independently of entry count.
const MIN_CACHED_STRING_CHARS = 4096;
const MAX_CACHED_STRINGS = 4096;
const MAX_CACHED_SOURCE_CHARS = 8 * 1024 * 1024; // 16 MiB at two bytes per UTF-16 code unit.

function serializedChars(value: unknown, stringChars: (text: string) => number): number {
  let adjustment = 0;
  const layout = JSON.stringify(value, (_key, part) => {
    if (typeof part !== "string" || part.length < MIN_CACHED_STRING_CHARS) return part;
    adjustment += stringChars(part) - 2;
    return "";
  });
  return layout.length + adjustment;
}

/** Exact sizes for mutable projections, plus weak numeric facts for immutable session sources. */
export function createJsonSizeMeasurer() {
  const lengths = new Map<string, number>();
  let retainedChars = 0;
  let sources = new WeakMap<object, number>();
  const measure = (value: unknown): number => serializedChars(value, part => {
    let length = lengths.get(part);
    if (length === undefined) {
      length = JSON.stringify(part).length;
      // Keep the stable prefix instead of thrashing when projected text exceeds the budget.
      if (lengths.size < MAX_CACHED_STRINGS && retainedChars + part.length <= MAX_CACHED_SOURCE_CHARS) {
        lengths.set(part, length);
        retainedChars += part.length;
      }
    }
    return length;
  });
  // Use only immutable session-entry identities here; mutable projections must use measure().
  const measureSource = (source: object, value: unknown): number => {
    const cached = sources.get(source);
    if (cached !== undefined) return cached;
    const length = serializedChars(value, part => JSON.stringify(part).length);
    sources.set(source, length);
    return length;
  };
  return {
    measure,
    measureSource,
    clear() {
      lengths.clear();
      retainedChars = 0;
      sources = new WeakMap();
    },
  };
}
