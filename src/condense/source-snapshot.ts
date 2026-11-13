import { isStringObject } from "node:util/types";

/** Flush-local JSON equality, without repeatedly copying long string values.
 * Stable string IDs preserve JSON's value types, ordering and normalization.
 * Mutations still change the snapshot, even with the same message/session leaf.
 * IDs are local to this closure: never persist or compare across instances. */
export function createSourceSnapshotter(): (value: unknown) => string | undefined {
  const strings = new Map<string, string>();
  const literals = new Map<string, string>();
  const isRawJSON = (JSON as typeof JSON & {
    isRawJSON?: (value: unknown) => value is { rawJSON: string };
  }).isRawJSON;
  const intern = (values: Map<string, string>, value: string, prefix: string) => {
    let id = values.get(value);
    if (id === undefined) {
      id = prefix + values.size;
      values.set(value, id);
    }
    return id;
  };
  return value => JSON.stringify(value, (_key, part: unknown) => {
    const text = typeof part === "string" ? part : isStringObject(part) ? String(part) : undefined;
    // Ordinary values need no second escaped copy. Only raw literals can have a distinct spelling.
    if (text !== undefined) return intern(strings, text, "s");
    if (isRawJSON?.(part) && part.rawJSON.startsWith('"')) {
      const value: unknown = JSON.parse(part.rawJSON);
      return typeof value === "string" && JSON.stringify(value) === part.rawJSON
        ? intern(strings, value, "s") : intern(literals, part.rawJSON, "r");
    }
    return part;
  });
}
