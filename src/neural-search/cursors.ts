import { randomUUID } from "node:crypto";
import type { FileFinderApi, GrepMode } from "@ff-labs/fff-node";
import type { ContentProgress } from "./native/content.ts";

export type SearchAction = "find" | "grep" | "multi_grep";
export interface SearchRequest {
  pattern?: string;
  patterns?: string[];
  path?: string;
  exclude?: string | string[];
  constraints?: string;
  caseSensitive?: boolean;
  context?: number;
  limit?: number;
  cursor?: string;
}
interface BaseCursor {
  scope: string;
  root: string;
  auxiliary: boolean;
  finder: FileFinderApi;
  request: SearchRequest;
  query: string;
}
export type SearchCursor = BaseCursor & (
  | { action: "find"; nextPageIndex: number }
  | { action: "grep"; progress: ContentProgress; mode: GrepMode }
  | { action: "multi_grep"; progress: ContentProgress }
);

export class CursorStore {
  private readonly entries = new Map<string, SearchCursor>();
  clear(): void { this.entries.clear(); }

  store(cursor: SearchCursor): string {
    const token = `ns_${randomUUID()}`;
    const request = structuredClone(cursor.request);
    delete request.cursor;
    this.entries.set(token, { ...cursor, request });
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    return token;
  }

  get<A extends SearchAction>(token: string, action: A, scope: string, request: SearchRequest): Extract<SearchCursor, { action: A }> {
    const cursor = this.entries.get(token);
    if (!cursor) throw new Error("Invalid or stale neural-search cursor. Repeat the search without a cursor.");
    if (cursor.action !== action || cursor.scope !== scope || cursor.finder.isDestroyed) {
      throw new Error("Stale neural-search cursor or wrong action/session/cwd/index. Repeat the search without a cursor.");
    }
    for (const key of Object.keys(request) as (keyof SearchRequest)[]) {
      if (key === "cursor" || request[key] === undefined) continue;
      if (JSON.stringify(request[key]) !== JSON.stringify(cursor.request[key])) {
        throw new Error(`Neural-search cursor does not match parameter "${key}". Repeat the original parameters or start a new search.`);
      }
    }
    return cursor as Extract<SearchCursor, { action: A }>;
  }
}
