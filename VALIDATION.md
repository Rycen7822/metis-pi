# Validation record — 0.3.0

## Delivery status

Default package entry: `index.ts`, which enables the compact Codex-style tool transcript. Version 0.3.0 revises the edit/diff surface from the 0.2.0 approximation to match the supplied Codex CLI reference more closely.

The GitHub remote has not been created or pushed from this environment. The connected GitHub account is `Rycen7822`; repository-content write actions are available for existing repositories, while no create-repository action is exposed by the connector. The target repository was previously unresolved/404. No remote state is claimed here.

## Checks actually executed

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | **62 passed; 0 failed; 0 skipped** | Formatting, Codex diff layout, ownership/teardown, non-mutation and package manifest |
| `npm run check:core` | **Passed** | Real TypeScript compiler, `src/**/*.ts` |
| `node --experimental-strip-types --check index.ts` | **Passed** | Entry syntax, not host type resolution |
| `bash -n scripts/publish-github.sh` | **Passed** | Script syntax only; no remote action |
| `npm run preview` | **Passed** | Actual formatter functions generated ANSI/plain preview data |
| Reference-image comparison | **Inspected** | Supplied Codex screenshot sampled delete/add backgrounds as `#4A221D` / `#213A2B`; renderer constants match exactly |
| Renderer snapshot | **Generated and visually inspected** | Local rasterization of formatter ANSI output; not a live Pi session |
| `npm pack --dry-run --ignore-scripts --json` | **Passed** | Package content check |
| `npm run check` | **Blocked; not passed** | TS2307 because Pi core/TUI peer packages are unavailable in this container |
| `npm run test:host` | **Blocked; not passed** | `ERR_MODULE_NOT_FOUND: @earendil-works/pi-coding-agent` before assertions |
| Full installed plugin stack | **Not run** | User's actual Pi/FFF/Zentui/LSP/RTK/etc. runtime is not present here |
| Real terminal mouse/clipboard/image protocols | **Not run** | Snapshot tests do not substitute for the target terminal |
| GitHub Actions | **Not run** | Requires repository push first |

Environment: Node.js `v22.16.0`, npm `10.9.2`, global TypeScript `5.8.3`. The package targets Node.js >=22.19.0, matching the inspected Pi 0.85.1 package requirement. No fake Pi package or type stub was substituted to claim host success.

## Diff fidelity added in 0.3.0

The supplied Codex CLI screenshot and the current `openai/codex` diff renderer were used as visual/behavioral references. The implementation is independent TypeScript code and does not embed Codex Rust source.

- Line numbers precede the gutter sign: `2030 -...` / `2030 +...`, matching the reference instead of Pi's sign-first source representation.
- Dark-terminal changed-line backgrounds are exactly `#4A221D` for deletions and `#213A2B` for additions.
- The tint fills each complete physical changed row to the tool viewport width, including the line-number/sign gutter and trailing space.
- Long changed lines wrap inside the content column. Continuation rows use a hanging indent aligned with the first row's content instead of repeating the number/sign or restarting at column zero.
- Context lines remain unfilled. Diff separators remain dim and unfilled.
- Deleted content receives a dim treatment while the deletion sign retains semantic red; additions retain the normal content intensity and green sign.
- Pi's already display-oriented edit diff is not subjected to a second arbitrary preview truncation.
- Real Pi mode uses `@earendil-works/pi-tui` wrapping and visible-width helpers so ANSI and CJK width are handled by the host.

## Non-interference invariants

- No tool registration/activation, executor replacement, schema changes, `tool_call`/`tool_result` content middleware, model-message mutation, session-entry mutation or prompt injection.
- The adapter reformats only rows whose source metadata identifies Pi's builtin tool implementation. FFF/LSP-style overrides of builtin names are skipped.
- Structured Codex tools, Web/MCP/session/subagent/question tools and existing self-shell renderers are left untouched.
- Tool definitions, execute references, args, text blocks, search evidence, image payloads and result details are unchanged; rich diff rendering receives a display copy of `details.diff` only.
- Zentui editor/footer/Working-line ownership, thinking controls, clipboard behavior and keyboard mappings are not replaced.
- Constructor/default child state is preserved; unknown ownership or incompatible host internals fail closed to the original renderer.
- Duplicate loading, later patches, owner changes and teardown behavior remain covered by the compatibility harness.

These tests validate the inspected interfaces and pure rendering behavior. They do not prove universal compatibility with every future Pi/plugin version or pixel identity across terminal fonts and color profiles.

## Reproduce full host verification

On Node.js >=22.19.0 with dependency access, from this source directory:

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run verify
```

The real-host smoke test constructs actual `ToolExecutionComponent` instances and verifies the compact shell, edit surface, exact truecolor escapes, expansion and custom-renderer fallback. It does not invoke a model or execute tool commands.
