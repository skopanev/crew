#!/usr/bin/env bash
set -euo pipefail
target="${TARGET_BRANCH:-}"
if [[ -z "$target" ]]; then
  target="$(jq -er '.target_branch | select(type == "string" and length > 0)' "$1/.ntkrc")"
fi
[[ "$target" != -* && "$target" != HEAD ]] && git check-ref-format "refs/heads/$target" >/dev/null
printf '%s\n' "$target"
