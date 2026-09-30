#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$root/native/code-mode-host"
output_dir="${1:-$root/.work/host-release}"
target_dir="${CARGO_TARGET_DIR:-$root/.work/host-build}"
target=x86_64-unknown-linux-gnu
archive=codex-code-mode-host-$target.tar.gz

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
	echo "This release build requires Linux x86_64" >&2
	exit 1
fi

# Release builds use one authenticated archive/binding pair, never ambient overrides.
for name in RUSTY_V8_ARCHIVE RUSTY_V8_SRC_BINDING_PATH RUSTY_V8_MIRROR V8_FROM_SOURCE V8_FORCE_DEBUG GN_ARGS EXTRA_GN_ARGS DOCS_RS DENO_TRYBUILD; do
	if [[ -n ${!name:-} ]]; then
		echo "Unset $name for a pinned release build" >&2
		exit 1
	fi
done
version=$(sed -n 's/^v8 = "=\([0-9][0-9.]*\)"$/\1/p' "$source_dir/Cargo.toml")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected one exact V8 version" >&2; exit 1; }
profile=ptrcomp_sandbox_release
target_dir=$(realpath -m -- "$target_dir")
inputs="$target_dir/v8-inputs/$version/$target/$profile"
manifest="rusty_v8_${profile}_${target}.sha256"
v8_archive="librusty_v8_${profile}_${target}.a.gz"
binding="src_binding_${profile}_${target}.rs"
base_url="https://github.com/openai/codex/releases/download/rusty-v8-v$version"
pin_file="$root/native/code-mode-host/v8-release-manifests.sha256"
manifest_hash=$(awk -v name="$manifest" '$2 == name { print $1 }' "$pin_file")
[[ $manifest_hash =~ ^[0-9a-f]{64}$ ]] || { echo "Missing unique V8 manifest pin" >&2; exit 1; }
mkdir -p -- "$inputs"
staging=$(mktemp -d "$inputs/.download.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT

verify_file() {
	printf '%s  %s\n' "$2" "$1" | sha256sum --check --status
}
fetch_verified() {
	local name=$1 digest=$2
	if [[ -f "$inputs/$name" ]]; then
		verify_file "$inputs/$name" "$digest" || { echo "Corrupt cached V8 input: $name" >&2; exit 1; }
		return
	fi
	curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 "$base_url/$name" --output "$staging/$name"
	verify_file "$staging/$name" "$digest" || { echo "V8 checksum mismatch: $name" >&2; exit 1; }
	mv -- "$staging/$name" "$inputs/$name"
}
fetch_verified "$manifest" "$manifest_hash"
# Only interpret filenames after authenticating the manifest bytes.
[[ $(wc -l < "$inputs/$manifest") == 2 ]] || { echo "Expected exactly two V8 artifacts" >&2; exit 1; }
for name in "$v8_archive" "$binding"; do
	digest=$(awk -v name="$name" '$2 == name { print $1 }' "$inputs/$manifest")
	[[ $digest =~ ^[0-9a-f]{64}$ ]] || { echo "Missing unique V8 artifact: $name" >&2; exit 1; }
	fetch_verified "$name" "$digest"
done
rm -rf -- "$staging"
trap - EXIT

RUSTY_V8_ARCHIVE="$inputs/$v8_archive" RUSTY_V8_SRC_BINDING_PATH="$inputs/$binding" \
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
