// Exact JSON character counts without rebuilding large, unchanged text values.
// Cache primitive values only: object identity must never conceal source edits.
export function createJsonSizeMeasurer() {
  const lengths = new Map<string, number>();
  const measure = (value: unknown): number => {
    let adjustment = 0;
    const layout = JSON.stringify(value, (_key, part) => {
      if (typeof part !== "string" || part.length < 4096) return part;
      let length = lengths.get(part);
      if (length === undefined) {
        length = JSON.stringify(part).length;
        // Retain at most 4096 source references, not encoded payloads. Keep
        // the stable history prefix instead of thrashing once it outgrows us.
        if (lengths.size < 4096) lengths.set(part, length);
      }
      adjustment += length - 2;
      return "";
    });
    return layout.length + adjustment;
  };
  return { measure, clear: () => lengths.clear(), get full() { return lengths.size === 4096; } };
}
