# Sourced by run.sh. The host worker proves ownership before it sets LANE_REUSE_HEAD.
# Check the exact clean commit again at each host startup boundary.
retained_worktree() {
  [[ -n "${LANE_REUSE_HEAD:-}" && -d "$worktree/.git" && ! -L "$worktree/.git" ]] || return 1
  jq -e --arg head "$LANE_REUSE_HEAD" '.ticket.retained.head == $head' "$claim_file" >/dev/null || return 1
  local head branch changes
  head="$(git -C "$worktree" -c core.fsmonitor=false -c core.hooksPath=/dev/null rev-parse HEAD)" || return 1
  branch="$(git -C "$worktree" symbolic-ref --short HEAD)" || return 1
  changes="$(git --no-optional-locks -C "$worktree" -c core.fsmonitor=false -c core.hooksPath=/dev/null \
    status --porcelain --untracked-files=all)" || return 1
  [[ "$head" == "$LANE_REUSE_HEAD" && "$branch" == "ticket-$ticket" && -z "$changes" ]]
}
