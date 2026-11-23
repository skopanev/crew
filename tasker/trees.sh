#!/usr/bin/env bash
# Develop trees of one tasker run. The agents and the checks read code only here, at one fixed develop commit.
# Usage: trees.sh add | remove. Needs MEDULLA_RUN_DIR, TASKER_REPOS (JSON {repository: shared checkout}) and TASKER_TREE_ROOT.
# TASKER_TREE_PREFIX names the flow in the worktree folder name (default tasker; ac-auditor uses its own).
# add fetches develop, adds one detached worktree for each repository and writes artifacts/trees.json.
# remove removes these worktrees without force. A worktree that git refuses to remove stays, with a message.
main() {
set -euo pipefail
artifacts="$MEDULLA_RUN_DIR/artifacts"
root="$TASKER_TREE_ROOT/${TASKER_TREE_PREFIX:-tasker}-$(basename "$MEDULLA_RUN_DIR")"
case "${1:-}" in
  add)
    [[ ! -e "$root" ]] || { echo "tasker-trees: $root already exists" >&2; exit 1; }
    mkdir -p "$root"
    trees='{}'
    while IFS=$'\t' read -r id repo; do
      # Parallel passes fetch the same repository. Git refuses a held ref lock, so try three times.
      for attempt in 1 2 3; do
        if git -C "$repo" fetch -q origin develop; then break; fi
        [[ "$attempt" -lt 3 ]] || { echo "tasker-trees: git fetch failed in $repo" >&2; exit 1; }
        sleep 5
      done
      sha="$(git -C "$repo" rev-parse --verify 'origin/develop^{commit}')"
      git -C "$repo" worktree add -q --detach "$root/$id" "$sha"
      trees="$(jq -c --arg id "$id" --arg path "$root/$id" --arg repo "$repo" --arg sha "$sha" \
        '. + {($id): {path: $path, repo: $repo, sha: $sha}}' <<< "$trees")"
      # Record each worktree at once, so remove also finds the worktrees of a failed add.
      printf '%s\n' "$trees" > "$artifacts/trees.json.tmp"
      mv "$artifacts/trees.json.tmp" "$artifacts/trees.json"
    done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' <<< "$TASKER_REPOS")
    ;;
  remove)
    [[ -f "$artifacts/trees.json" ]] || exit 0
    while IFS=$'\t' read -r repo tree; do
      git -C "$repo" worktree remove "$tree" || echo "tasker-trees: kept $tree, git refused to remove it" >&2
    done < <(jq -r '.[] | [.repo, .path] | @tsv' "$artifacts/trees.json")
    rmdir "$root" 2>/dev/null || true
    ;;
  *) echo 'usage: trees.sh add | remove' >&2; exit 2 ;;
esac
}
main "$@"; exit $?
