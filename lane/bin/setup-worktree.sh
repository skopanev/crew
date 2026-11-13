# Source from a fresh or retained checkout. Keep repository setup identical on both paths.
if [ -f scripts/install-git-hooks.sh ]; then
  bash scripts/install-git-hooks.sh
elif [ -d .githooks ]; then
  for hook in .githooks/*; do
    [ -f "$hook" ] || continue
    name="$(basename "$hook")"
    printf '#!/usr/bin/env bash\nexec bash "$(git rev-parse --show-toplevel)/.githooks/%s" "$@"\n' "$name" > ".git/hooks/$name"
    chmod +x ".git/hooks/$name"
  done
elif grep -qE '^[[:space:]]*hooksPath[[:space:]]*=' "$project_dir/.git/config"; then
  echo 'Source uses external hooks; no tracked .githooks in candidate' >&2
  exit 1
fi
export PATH="/home/medulla/.bun/bin:${PATH}"
deps=""
pf="${REPOSITORY_PREFLIGHT:-}"
if [ -n "$pf" ]; then
  if [ -x "${LANE_WORKTREE}/$pf" ]; then
    if (cd "$LANE_WORKTREE" && timeout 600 "./$pf" > "$MEDULLA_RUN_DIR/artifacts/preflight.txt" 2>&1); then
      deps=" Repository preflight ($pf) ran."
    else
      cat "$MEDULLA_RUN_DIR/artifacts/preflight.txt" >&2
      echo "Repository preflight ($pf) failed; see artifacts/preflight.txt" >&2
      exit 1
    fi
  else
    echo "Repository preflight ($pf) is not executable in the candidate" >&2
    exit 1
  fi
elif [ -f "$LANE_WORKTREE/package.json" ] && command -v bun >/dev/null 2>&1; then
  if (cd "$LANE_WORKTREE" && timeout 240 bun install --frozen-lockfile > "$MEDULLA_RUN_DIR/artifacts/bun-install.txt" 2>&1); then
    deps=' Dependencies are installed.'
  else
    deps=" NOTE: bun install did not complete. Full log: $MEDULLA_RUN_DIR/artifacts/bun-install.txt"
  fi
fi
