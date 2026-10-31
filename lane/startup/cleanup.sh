# Sourced by lane/run.sh: EXIT cleanup of the private worktree and connectors. Uses run.sh variables.
cleanup() {
  local code=$? base head changes cleanup_target hook_rc retry land_base retain_worktree=false
  if [[ "${worktree_created:-false}" == true && -d "$worktree" && ! -L "$worktree" ]]; then
    if [[ -z "$(ls -A "$worktree")" ]]; then
      rmdir "$worktree" && printf 'run.sh: removed unused worktree: %s\r\n' "$worktree"
    elif [[ "$code" -eq 0 ]]; then
      cleanup_target="$target"
      if [[ "${LANE_DELIVERY:-branch}" == branch ]] \
        || [[ "${LANE_DELIVERY:-}" == requirement && "${LANE_REQUIREMENT_FINAL:-false}" != true ]]; then
        cleanup_target="${LANE_DELIVERY_BRANCH:-ticket-$ticket}"
        [[ ! -f "$worktree/.git/lane-verified" ]] || cleanup_target="$target"
      fi
      if [[ -n "$cleanup_target" ]] \
        && changes="$(git --no-optional-locks -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null)" \
        && [[ -z "$changes" ]] \
        && git -C "$worktree" merge-base --is-ancestor HEAD "refs/remotes/origin/$cleanup_target"; then
        if [[ -n "$after_land" && "$cleanup_target" == "$target" && ! -f "$worktree/.git/lane-verified" ]]; then
          head="$(git -C "$worktree" rev-parse HEAD)"
          land_base="$(cat "$worktree/.git/lane-base" 2>/dev/null || true)"
          printf -v retry 'cd %q && timeout --kill-after=5s 120s %q %q %q %q %q' \
            "$worktree" "$repo/$after_land" "$worktree" "$head" "$target" "$land_base"
          hook_rc=2
          if [[ "$land_base" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
            && git -C "$worktree" merge-base --is-ancestor "$land_base" "$head"; then
            hook_rc=0
            (cd "$worktree" && timeout --kill-after=5s 120s "$repo/$after_land" "$worktree" "$head" "$target" "$land_base") || hook_rc=$?
          else
            say 'run.sh: pre-land target SHA is missing or invalid; afterLand was not run'
          fi
          if [[ "$hook_rc" -ne 0 ]] \
            || [[ "$(git -C "$worktree" rev-parse HEAD 2>/dev/null)" != "$head" ]] \
            || ! changes="$(git --no-optional-locks -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null)" \
            || [[ -n "$changes" ]]; then
            say "run.sh: POST_LAND_FAILED: retry: $retry"
            say "run.sh: retained landed worktree: $worktree (afterLand exit $hook_rc)"
            retain_worktree=true
          fi
        fi
        if [[ "$retain_worktree" == false ]]; then
          if rm -rf -- "$worktree"; then
            printf 'run.sh: removed completed worktree: %s\r\n' "$worktree"
          else
            say "run.sh: cannot remove completed worktree: $worktree" >&2
          fi
        fi
      else
        say "run.sh: retained worktree: clean landed state not confirmed at $worktree" >&2
      fi
    elif [[ "${LANE_FINALIZE_ONLY:-false}" == true && -d "$worktree/.git" ]] \
      && changes="$(git --no-optional-locks -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null)" \
      && [[ -z "$changes" ]]; then
      # No agent writes in a finalizer. Its clean source comes from published inputs.
      rm -rf -- "$worktree"
    elif [[ -d "$worktree/.git" && -f "$worktree/.git/lane-base" ]]; then
      if base="$(cat "$worktree/.git/lane-base" 2>/dev/null)" \
        && head="$(git --no-optional-locks -C "$worktree" rev-parse HEAD 2>/dev/null)" \
        && changes="$(git --no-optional-locks -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null)" \
        && [[ -n "$base" && "$head" == "$base" && -z "$changes" ]]; then
        if rm -rf -- "$worktree"; then
          printf 'run.sh: removed unchanged worktree: %s\r\n' "$worktree"
        fi
      fi
    fi
  fi
  [[ -z "${cbm_connector_dir:-}" ]] || rm -rf "$cbm_connector_dir"
  [[ -z "${joppa_connector_dir:-}" ]] || rm -rf "$joppa_connector_dir"
  return "$code"
}
