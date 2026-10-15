#!/usr/bin/env bash
# The caller holds the shared target lock until this process finishes.
set -euo pipefail
target=${1:?target branch required}
cd "$LANE_WORKTREE"
artifacts="$MEDULLA_RUN_DIR/artifacts"
snapshot="$artifacts/reviewed-tree.txt"
fail() { printf '<signal:%s>%s</signal:%s>\n' "$1" "$2" "$1"; exit 0; }
before=$(git rev-parse HEAD)
[ "$before" = "$(sed -n 2p "$snapshot")" ] &&
  [ "$(git write-tree)" = "$(sed -n 1p "$snapshot")" ] &&
  [ -z "$(git status --porcelain)" ] || fail LAND_FAILED 'Candidate changed while waiting for the target lock.'
for attempt in 1 2; do
  rc=0
  if [ -n "${REQUIREMENT_BRANCH:-}" ]; then
    timeout 120 git fetch origin > "$artifacts/fetch.txt" 2>&1 || fail LAND_FAILED 'Target fetch failed before requirement integration.'
    if ! git merge --no-edit "origin/$target" > "$artifacts/rebase-log.txt" 2>&1; then
      git status --short > "$artifacts/rebase-status.txt"
      git merge --abort || fail LAND_FAILED 'Cannot restore the candidate after a target merge conflict.'
      fail MERGE_CONFLICT 'Default branch merge conflicts; requirement branch is retained. See artifacts/rebase-log.txt.'
    fi
  else
    bash "$TOOLING_ROOT/lane/bin/rebase.sh" "$target" || rc=$?
  fi
  case "$rc" in
    0) ;;
    3) fail CONFLICT 'Target rebase conflicts; see artifacts/rebase-log.txt and rebase-status.txt.' ;;
    *) fail LAND_FAILED 'Target refresh or rebase failed; see artifacts/fetch.txt and rebase-log.txt.' ;;
  esac
  if { [ -n "${REQUIREMENT_BRANCH:-}" ] && [ "$attempt" -eq 1 ]; } \
     || ! python3 "$TOOLING_ROOT/lane/bin/gates.py" verify >/dev/null 2>&1; then
    if ! python3 "$TOOLING_ROOT/lane/bin/gates.py" run; then
      if [ -n "${REQUIREMENT_BRANCH:-}" ]; then
        fail REQUIREMENT_GATE_FAIL 'Requirement checks failed; candidate retained on the requirement branch. See artifacts/gates.'
      fi
      fail GATE_FAIL 'Post-rebase checks failed; see artifacts/gates for logs and receipts.'
    fi
  fi
  python3 "$TOOLING_ROOT/lane/bin/gates.py" verify || fail LAND_FAILED 'Post-rebase gate receipt is invalid.'
  printf '%s\n%s\n' "$(git write-tree)" "$(git rev-parse HEAD)" > "$snapshot"
  if [ -n "${REQUIREMENT_BRANCH:-}" ]; then
    node "$TOOLING_ROOT/lane/bin/requirement-current.mjs" ||
      fail REQUIREMENT_CHANGED 'Requirement context changed or could not be read; candidate retained on the requirement branch.'
  fi
  rc=0
  bash "$TOOLING_ROOT/lane/bin/land.sh" "$target" > "$artifacts/landing-log.txt" 2>&1 || rc=$?
  cat "$artifacts/landing-log.txt"
  [ "$rc" -eq 0 ] && exit 0
  [ "$rc" -eq 3 ] || fail LAND_FAILED "Landing exited $rc; see artifacts/landing-log.txt."
  [ "$attempt" -eq 1 ] || fail LAND_FAILED 'TARGET_MOVED: Target moved twice during landing; see artifacts/landing-log.txt.'
  echo 'landing: target moved before push; refreshing once more' >&2
done
