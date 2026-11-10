#!/usr/bin/env bash
# Creates a sparse test file of <size> (bytes, or with K/M/G suffix) at <path>, writes random 64 KiB blocks at
# the start, at the end and every 97 MiB so hashing and block indexing are exercised, then prints its SHA-256
# (docs/TESTING_AND_CI.md §6). Fixtures are generated in CI and never committed.
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "usage: $0 <size> <path>" >&2
  exit 2
fi
size_arg=$1
path=$2
case "$size_arg" in
  *[Gg]) bytes=$(( ${size_arg%[Gg]} * 1024 * 1024 * 1024 )) ;;
  *[Mm]) bytes=$(( ${size_arg%[Mm]} * 1024 * 1024 )) ;;
  *[Kk]) bytes=$(( ${size_arg%[Kk]} * 1024 )) ;;
  *) bytes=$size_arg ;;
esac
block=65536
rm -f "$path"
truncate -s "$bytes" "$path"
write_at() {
  local offset=$1
  local n=$block
  if [ $(( offset + n )) -gt "$bytes" ]; then n=$(( bytes - offset )); fi
  [ "$n" -gt 0 ] || return 0
  head -c "$n" /dev/urandom | dd of="$path" bs=1 seek="$offset" conv=notrunc status=none 2>/dev/null ||
    head -c "$n" /dev/urandom | dd of="$path" oflag=seek_bytes seek="$offset" conv=notrunc status=none
}
write_at 0
step=$(( 97 * 1024 * 1024 ))
for (( off = step; off < bytes; off += step )); do write_at "$off"; done
if [ "$bytes" -gt "$block" ]; then write_at $(( bytes - block )); fi
sha256sum "$path" | cut -d' ' -f1
