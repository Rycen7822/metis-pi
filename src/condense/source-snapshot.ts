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
  const intern = (literal: string) => {
    let id = literals.get(literal);
    if (id === undefined) {
      id = String(literals.size);
      literals.set(literal, id);
    }
    return id;
  };
  return value => JSON.stringify(value, (_key, part: unknown) => {
    const text = typeof part === "string" ? part : isStringObject(part) ? String(part) : undefined;
    if (text !== undefined) {
      let id = strings.get(text);
      if (id === undefined) {
        id = intern(JSON.stringify(text));
        strings.set(text, id);
      }
      return id;
    }
    // Raw string literals bypass JSON's escaping; retain their exact spelling.
    if (isRawJSON?.(part) && part.rawJSON.startsWith('"')) return intern(part.rawJSON);
    return part;
  });
}
