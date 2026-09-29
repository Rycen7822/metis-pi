#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$root/vendor/pi-codex-conversion/code-mode/vendor/code-mode-src"
output_dir="${1:-$root/.work/host-release}"
target_dir="${CARGO_TARGET_DIR:-$root/.work/host-build}"
target=x86_64-unknown-linux-gnu
archive=codex-code-mode-host-$target.tar.gz

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
	echo "This release build requires Linux x86_64" >&2
	exit 1
fi

CARGO_TARGET_DIR="$target_dir" cargo build --release --locked --target "$target" \
	--manifest-path "$source_dir/Cargo.toml" -p codex-code-mode-host

staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
install -m 755 "$target_dir/$target/release/codex-code-mode-host" "$staging/codex-code-mode-host"
strip --strip-all "$staging/codex-code-mode-host"

max_glibc=$(objdump -T "$staging/codex-code-mode-host" | \
	sed -n 's/.*GLIBC_\([0-9][0-9.]*\).*/\1/p' | sort -Vu | tail -n 1)
if [[ -z "$max_glibc" || $(printf '%s\n' '2.34' "$max_glibc" | sort -V | tail -n 1) != '2.34' ]]; then
	echo "Host requires GLIBC_${max_glibc:-unknown}; release policy permits at most GLIBC_2.34" >&2
	exit 1
fi

mkdir -p -- "$output_dir"
tar --format=ustar --mtime='@0' --owner=0 --group=0 --numeric-owner \
	-C "$staging" -cf - codex-code-mode-host | gzip -n > "$output_dir/$archive"
(cd "$output_dir" && sha256sum "$archive" > SHA256SUMS)
echo "GLIBC_$max_glibc"
cat "$output_dir/SHA256SUMS"
