#!/usr/bin/env bash
# Refresh a clean candidate. Return 3 for one repairable conflict, 2 for other failures.
set -euo pipefail
target=${1:?target branch required}
git check-ref-format "refs/heads/$target" >/dev/null || exit 2
artifacts="$MEDULLA_RUN_DIR/artifacts"
if ! timeout 120 git fetch origin > "$artifacts/fetch.txt" 2>&1; then
  cat "$artifacts/fetch.txt" >&2
  exit 2
fi
git rev-parse --verify "refs/remotes/origin/$target" >/dev/null || exit 2
if git merge-base --is-ancestor "origin/$target" HEAD; then
  [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$target")" ] || exit 2
  exit 0
fi
if git rebase "origin/$target" > "$artifacts/rebase-log.txt" 2>&1; then
  cat "$artifacts/rebase-log.txt"
  [ -n "$(git log --oneline "origin/$target..HEAD")" ] || exit 2
  exit 0
fi
cat "$artifacts/rebase-log.txt" >&2
git status --short > "$artifacts/rebase-status.txt"
conflicts=$(git diff --name-only --diff-filter=U)
git rebase --abort || exit 2
if [ -z "$conflicts" ]; then exit 2; fi
[ -f "$MEDULLA_RUN_DIR/journal.jsonl" ] || exit 2
tried=$(jq -sr '[.[] | select(.node == "git_fix")] | length' "$MEDULLA_RUN_DIR/journal.jsonl" 2>/dev/null) || exit 2
if [ "$tried" -ge 1 ]; then
  echo 'Rebase still conflicts after the repair attempt.' >&2
  exit 2
fi
exit 3
