# Sourced by run.sh. The host worker proves ownership before it sets LANE_REUSE_HEAD.
# Check the exact clean commit again at each host startup boundary.
worktree_git() {
  git --no-optional-locks --git-dir="$worktree/.git" --work-tree="$worktree" \
    -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}
owned_worktree() {
  [[ -n "${LANE_OWNED_CHECKOUT:-}" && -d "$worktree" && ! -L "$worktree" && -z "$(ls -A "$worktree")" ]] || return 1
  local identity
  identity="$(node -e 'const s=require("node:fs").lstatSync(process.argv[1]); console.log(`${s.dev}:${s.ino}`)' "$worktree")" || return 1
  [[ "$identity" == "$LANE_OWNED_CHECKOUT" ]]
}

check_worktree_directory() {
  [[ ! -L "$worktree_root" && ! -L "$worktree" ]] || {
    say 'run.sh: worktree path is a symlink; startup refused'; return 2; }
  if [[ -n "${LANE_OWNED_CHECKOUT:-}" ]]; then
    owned_worktree || { say "run.sh: WORKTREE PREEXISTED: $worktree; host ownership changed"; return 73; }
  elif [[ -e "$worktree" ]] && { [[ ! -d "$worktree" ]] || [[ -n "$(ls -A "$worktree")" ]]; }; then
    retained_worktree || { say "run.sh: WORKTREE PREEXISTED: $worktree; retained unchanged; inspect before retrying"; return 73; }
  fi
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
  if [[ -n "${LANE_OWNED_CHECKOUT:-}" ]]; then owned_worktree;
  elif [[ -n "${LANE_REUSE_HEAD:-}" ]]; then retained_worktree;
  else mkdir "$worktree" 2>/dev/null; fi
}
