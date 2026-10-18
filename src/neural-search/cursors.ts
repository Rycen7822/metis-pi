import { randomUUID } from "node:crypto";
import type { FileFinderApi, GrepMode, SearchResult } from "@ff-labs/fff-node";
import type { ContentProgress } from "./native/content.ts";

export const FIND_SNAPSHOT_LIMIT = 10_000;
const FIND_CACHE_LIMIT = 20_000;
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
}
export type SearchCursor = BaseCursor & (
  | { action: "find"; snapshot: SearchResult; nextPageIndex: number }
  | { action: "grep"; query: string; progress: ContentProgress; mode: GrepMode }
  | { action: "multi_grep"; query: string; progress: ContentProgress }
);

export class CursorStore {
  private readonly entries = new Map<string, SearchCursor>();
  clear(): void { this.entries.clear(); }

  store(cursor: SearchCursor): string {
    const token = `ns_${randomUUID()}`;
    const request = structuredClone(cursor.request);
    delete request.cursor;
    this.entries.set(token, { ...cursor, request });
    this.trim();
    return token;
  }

  private trim(): void {
    const snapshots = new Set([...this.entries.values()].flatMap(cursor => cursor.action === "find" ? [cursor.snapshot] : []));
    let matches = [...snapshots].reduce((sum, snapshot) => sum + snapshot.items.length, 0);
    while (this.entries.size > 200 || matches > FIND_CACHE_LIMIT) {
      const token = this.entries.keys().next().value!;
      const oldest = this.entries.get(token)!;
      this.entries.delete(token);
      if (oldest.action === "find" && ![...this.entries.values()].some(cursor => cursor.action === "find" && cursor.snapshot === oldest.snapshot))
        matches -= oldest.snapshot.items.length;
    }
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
