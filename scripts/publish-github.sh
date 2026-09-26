#!/usr/bin/env bash
# Explicit local fallback: creates a NEW PRIVATE repo and pushes reviewed files.
# No token is requested or embedded. Uses the caller's existing gh authentication.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
for command in git gh node; do
  command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done
node --input-type=module -e '
import { readFileSync } from "node:fs";
if (JSON.parse(readFileSync("package.json", "utf8")).name !== "@rycen7822/metis-pi") process.exit(1);
'
login="$(gh api user --jq .login)"
[[ "$login" == "Rycen7822" ]] || { printf 'Expected Rycen7822, got %s. Stopping.\n' "$login" >&2; exit 1; }
repo="$login/metis-pi"
probe="$(mktemp)"
trap 'rm -f "$probe"' EXIT
if gh api "repos/$repo" --silent 2>"$probe"; then
  printf 'Repository %s already exists; refusing to overwrite or push automatically.\n' "$repo" >&2
  exit 1
elif ! grep -q 'HTTP 404' "$probe"; then
  cat "$probe" >&2
  exit 1
fi
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo 'Refusing to use an existing git repository or its history. Extract a fresh copy first.' >&2
  exit 1
fi
git init -b main
# Exact allowlist: no directory globbing, staged leftovers, local settings or credentials.
git add -- \
  index.ts src/adapter.ts src/extension.ts src/renderers.ts \
  themes/metis-pi.json \
  test/adapter.test.mjs test/helpers.mjs test/package.test.mjs test/renderers.test.mjs \
  test/contract/host-entry.test.mjs scripts/publish-github.sh scripts/preview.mjs \
  package.json tsconfig.json tsconfig.core.json \
  README.md LICENSE NOTICE VALIDATION.md CHANGELOG.md .gitignore .github/workflows/ci.yml \
  docs/compatibility.md docs/preview.html docs/preview.png docs/transcript.ansi docs/transcript.txt
id="$(gh api user --jq .id)"
git -c user.name="$login" -c user.email="$id+$login@users.noreply.github.com" \
  commit -m 'feat: enable Codex-style compact tool transcript by default'
gh repo create "$repo" --private --description 'Display-only Codex-inspired Pi appearance; preserves tool execution and model context' \
  --source "$root" --remote origin --push
gh repo view "$repo" --json nameWithOwner,isPrivate,url
