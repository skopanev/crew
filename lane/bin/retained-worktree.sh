#!/usr/bin/env bash
# Reuse only the clean candidate that the host worker confirmed for this Task.
set -euo pipefail
cd "$LANE_WORKTREE"
retained="$MEDULLA_RUN_DIR/artifacts/claim.json"
head="$(jq -er '.ticket.retained.head' "$retained")"
tree="$(jq -er '.ticket.retained.tree' "$retained")"
base="$(jq -er '.ticket.retained.base' "$retained")"
route="$(jq -er '.ticket.retained.route' "$retained")"
if ! { [[ "$route" == coder || "$route" == review ]] && \
  [[ "$(git symbolic-ref --short HEAD)" == "ticket-$ticket_id" && "$(git rev-parse HEAD)" == "$head" \
  && "$(git rev-parse 'HEAD^{tree}')" == "$tree" && "$(cat .git/lane-base)" == "$base" \
  && -z "$(git status --porcelain --untracked-files=all)" ]]; }; then
  echo '<signal:RETAINED_CHANGED>Retained candidate changed after the host ownership check; checkout preserved.</signal:RETAINED_CHANGED>'
  exit 0
fi
target="$(bash "$TOOLING_ROOT/lane/bin/target.sh" "$project_dir")"
rc=0
bash "$TOOLING_ROOT/lane/bin/rebase.sh" "$target" || rc=$?
if [[ "$rc" != 0 ]]; then
  signal=FETCH_FAILED
  [[ "$rc" != 3 ]] || signal=MERGE_CONFLICT
  printf '<signal:%s>Retained candidate refresh failed; see artifacts/fetch.txt and rebase-log.txt.</signal:%s>\n' "$signal" "$signal"
  exit 0
fi
base="$(git rev-parse "origin/$target")"
printf '%s\n' "$base" > .git/lane-base
source "$TOOLING_ROOT/lane/bin/setup-worktree.sh"
# Rebase only clean commits. Then stage this Task's changes for a new commit with native hooks.
# This also removes the no-verify status of a SAVE STATE checkpoint.
git reset --soft "$base"
if [[ "$route" == review ]]; then
  printf '<signal:RESUME_REVIEW>Retained implementation: run current hooks, gates and all reviewers again.%s</signal:RESUME_REVIEW>\n' "$deps"
else
  printf '<signal:READY>Continue the retained implementation. Read artifacts/prior/failure.txt and the prior review reports. Repair the recorded blockers only.%s</signal:READY>\n' "$deps"
fi
