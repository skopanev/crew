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
rc=0
bash "$TOOLING_ROOT/lane/bin/rebase.sh" "$target" || rc=$?
case "$rc" in
  0) ;;
  3) fail CONFLICT 'Target rebase conflicts; see artifacts/rebase-log.txt and rebase-status.txt.' ;;
  *) fail LAND_FAILED 'Target refresh or rebase failed; see artifacts/fetch.txt and rebase-log.txt.' ;;
esac
if [ "$(git rev-parse HEAD)" != "$before" ]; then
  if ! python3 "$TOOLING_ROOT/lane/bin/gates.py" run; then
    fail GATE_FAIL 'Post-rebase checks failed; see artifacts/gates for logs and receipts.'
  fi
  python3 "$TOOLING_ROOT/lane/bin/gates.py" verify || fail LAND_FAILED 'Post-rebase gate receipt is invalid.'
  printf '%s\n%s\n' "$(git write-tree)" "$(git rev-parse HEAD)" > "$snapshot"
fi
rc=0
bash "$TOOLING_ROOT/lane/bin/land.sh" "$target" > "$artifacts/landing-log.txt" 2>&1 || rc=$?
cat "$artifacts/landing-log.txt"
if [ "$rc" -ne 0 ]; then
  fail LAND_FAILED "Landing exited $rc; see artifacts/landing-log.txt. No automatic gate replay."
fi
