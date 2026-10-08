---
name: ast-grep
description: "Use ast-grep for structural code search: AST-aware matching of call shapes, language constructs, nested scopes, and required or missing child nodes. Prefer fffind/ffgrep for filenames, keywords, strings, documentation, and broad text searches."
---

# ast-grep Structural Search

Use this skill when the query depends on code structure, not plain text. It uses the `ast-grep` CLI through `bash`; it does not require an MCP service or register a separate Pi tool. Check `ast-grep --version` if availability is uncertain. If the command is missing, report that dependency rather than silently installing or upgrading it.

Good uses:
- find function, class, import, decorator, call, or exception-handling shapes
- find code inside a particular syntactic scope
- find required or missing child nodes, such as `raise`, `await`, or `try`
- find calls with particular argument shapes
- inspect AST node kinds before writing a more exact rule

For ordinary keyword, string, filename, documentation, or broad text searches, use `fffind` and `ffgrep` first. If FFF is unavailable, use scoped `fd`/`rg`. AST matching is not type checking or project-wide symbol resolution: identical method names need not refer to the same binding or runtime behavior.

## Workflow

1. Identify the language and exact structure to match.
2. Use `fffind` for candidate paths and `ffgrep` for textual anchors; restrict the AST search to those files or the smallest relevant directory.
3. Start with `ast-grep run --pattern` for a simple single-node match.
4. Use `ast-grep scan` with YAML or inline rules when relationships such as `has`, `inside`, or `not` are needed.
5. Check a small positive example and a negative control before broad scans.
6. Use `--debug-query=ast|cst|pattern` on a small snippet for unexpected matches.
7. Report paths and code evidence. Do not infer types, bindings, or whole-function control flow solely from a matching tree shape.

Search is read-only. Use rewrite/update options only when the user requests code changes; inspect the proposed patch, preserve unrelated code, and run the closest meaningful checks. Do not use `--update-all` just to investigate code.

## TypeScript / JavaScript

Find calls on a particular receiver, including multiline argument/member chains:

```bash
ast-grep run --pattern 'ctx.ui.notify($$$ARGS)' --lang ts src/
```

Find the same call shape on any syntactic receiver:

```bash
ast-grep run --pattern '$OBJ.ui.notify($$$ARGS)' --lang ts src/
```

Use `--lang js` or `--lang tsx` for those languages. To constrain a call to an ancestor function declaration:

```bash
ast-grep scan --inline-rules 'id: ts-notify-in-function
language: ts
rule:
  pattern: $OBJ.ui.notify($$$ARGS)
  inside:
    kind: function_declaration
    stopBy: end' src/
```

An ancestor/descendant match can cross nested function boundaries. Add explicit constraints if the question concerns the nearest function or a particular scope.

## Python

```bash
ast-grep run --pattern 'print($$$ARGS)' --lang python src/
ast-grep run --pattern 'logger.$METHOD($$$ARGS)' --lang python src/
ast-grep run --pattern $'def $NAME($$$ARGS):\n    $$$BODY' --lang python src/
```

Find functions with a descendant raise statement:

```bash
ast-grep scan --inline-rules 'id: python-function-raises
language: python
rule:
  kind: function_definition
  has:
    pattern: raise $ERR
    stopBy: end' src/
```

## Debugging and Structured Output

Inspect a pattern and tiny input without scanning the project:

```bash
printf '%s\n' 'ctx.ui.notify("ok", "info");' | ast-grep run --pattern 'ctx.ui.notify($$$ARGS)' --lang ts --debug-query=ast --stdin
```

Use JSON when consuming matches programmatically:

```bash
ast-grep run --pattern '$OBJ.ui.notify($$$ARGS)' --lang ts --json=compact src/
```

Keep patterns single-quoted so the shell does not expand `$NAME`. For multiline Python patterns use Bash `$'...'` quoting or a YAML rule file. Choose `stopBy` deliberately: `end` searches deeply, while the default `neighbor` is immediate. Use `all`, `any`, and `not` for composite logic, and test missing-child rules against realistic nested scopes before drawing conclusions.

## References

Read [references/rule_reference.md](references/rule_reference.md) only when detailed rule syntax, metavariables, or relationships are needed. This reference is installed locally alongside this skill.
