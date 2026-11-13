# Sourced by run.sh. The host worker proves ownership before it sets LANE_REUSE_HEAD.
# Check the exact clean commit again at each host startup boundary.
worktree_git() {
  git --no-optional-locks --git-dir="$worktree/.git" --work-tree="$worktree" \
    -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}
retained_worktree() {
  [[ -n "${LANE_REUSE_HEAD:-}" && -d "$worktree/.git" && ! -L "$worktree/.git" ]] || return 1
  jq -e --arg head "$LANE_REUSE_HEAD" '.ticket.retained.head == $head' "$claim_file" >/dev/null || return 1
  local head branch changes
  head="$(worktree_git rev-parse HEAD)" || return 1
  branch="$(worktree_git symbolic-ref --short HEAD)" || return 1
  changes="$(worktree_git status --porcelain --untracked-files=all --ignore-submodules=all)" || return 1
  [[ "$head" == "$LANE_REUSE_HEAD" && "$branch" == "ticket-$ticket" && -z "$changes" ]]
}

prepare_worktree_directory() {
  if [[ -n "${LANE_REUSE_HEAD:-}" ]]; then retained_worktree;
  else mkdir "$worktree" 2>/dev/null; fi
}
