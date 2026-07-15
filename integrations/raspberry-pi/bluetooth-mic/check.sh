#!/usr/bin/env bash
# Run repository checks that need a Linux/Pi userspace. This script is read-only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPDIR="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$APPDIR/../.." && pwd)"
TMPDIR_CHECK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_CHECK"' EXIT

for command in node npm python3 bash; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find "$APPDIR" -type f -name '*.sh' -print0)

PYTHONPYCACHEPREFIX="$TMPDIR_CHECK/pycache" \
  python3 -m py_compile "$HERE"/scripts/*.py

if command -v shellcheck >/dev/null; then
  mapfile -d '' shell_scripts < <(find "$APPDIR" -type f -name '*.sh' -print0)
  shellcheck "${shell_scripts[@]}"
else
  echo "[check] shellcheck not installed; syntax checks still ran" >&2
fi

(cd "$REPO" && npm run check --workspace convbased-raspberry-pi)
echo "[check] Raspberry Pi integration checks passed"
