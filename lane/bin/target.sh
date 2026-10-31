#!/usr/bin/env bash
set -euo pipefail
# The repository's configured targetBranch reaches the lane as TARGET_BRANCH.
target="${TARGET_BRANCH:-}"
[[ -n "$target" ]] || { echo 'target.sh: TARGET_BRANCH is required' >&2; exit 1; }
[[ "$target" != -* && "$target" != HEAD ]] && git check-ref-format "refs/heads/$target" >/dev/null
printf '%s\n' "$target"
