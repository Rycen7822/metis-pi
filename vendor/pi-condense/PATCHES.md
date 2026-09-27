# Local changes

- `src/query-tool.ts`: bounded UTF-8 pages with a selection/session cursor, explicit archive errors, a budget for the whole JSON response, and no unbounded raw records in result details. Uses the host's `typebox` package. The tool name and `toolCallIds` remain compatible; follow `nextCursor` for the rest of a large or multi-record response.
- `package.json` / `tsconfig.json`: compile a self-contained runtime into `dist/` against Pi's host packages.
- Parent entry `extensions/condense.ts`: defer registration until tool discovery is available; yield to an external `context_tree_query` owner with a migration notice; display cumulative summarizer usage through the existing extension status channel without adding it to the standard-usage footer total.

The upstream summarizer, triggers, defaults, pruning, chain compression, grace rules, index, spill format, session restoration and persistence are unchanged.
