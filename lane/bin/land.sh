#!/usr/bin/env bash
# Land a clean, reviewed candidate using native hooks and a normal push.
# Refuse a diverged target; verify its final SHA.
set -euo pipefail
usage() { echo 'land.sh <target-branch>'; }
[[ $# -eq 1 && "$1" != -h && "$1" != --help ]] || { usage; exit 2; }
target="$1"
budget_check() {
  if [ -n "${LANE_LANDING_DEADLINE:-}" ]; then
    reserve="${PUBLISH_RESERVE_SECONDS:-240}"
    [[ "$LANE_LANDING_DEADLINE" =~ ^[0-9]+$ && "$reserve" =~ ^[0-9]+$ ]] || exit 2
    if [ "$((LANE_LANDING_DEADLINE - $(date +%s)))" -lt "$reserve" ]; then
      echo 'PUBLISH_BUDGET_LOW: not enough workflow time remains for publication and completion' >&2
      exit 76
    fi
  fi
}
budget_check
[[ "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "lane-push: недопустимая ветка: $target" >&2; exit 2; }

git rev-parse --git-dir >/dev/null 2>&1 || { echo 'lane-push: не репозиторий' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || {
  echo 'lane-push: рабочее дерево грязное — сначала сохрани работу, пуш незакоммиченного не бывает' >&2; exit 2; }

sha="$(git rev-parse HEAD)"
python3 "$(dirname "${BASH_SOURCE[0]}")/gates.py" verify
before="$(timeout 15 git ls-remote origin "refs/heads/$target" 2>/dev/null | awk '{print $1}' | head -1)" || {
  echo 'lane-push: target read failed before publication' >&2; exit 2; }
echo "lane-push: HEAD=$sha target=$target before=${before:-<ветки нет>}"
# A no-new-red proof holds only for the exact target that its red baseline checked.
if [[ "${NO_NEW_RED:-}" == last && ! -e "${MEDULLA_RUN_DIR:-}/artifacts/gates/current.json" ]]; then
  checked_base="$(python3 "$(dirname "${BASH_SOURCE[0]}")/no_new_red.py" base "$MEDULLA_RUN_DIR/artifacts/gates/no-new-red.json")"
  [[ -n "$before" && "$before" == "$checked_base" ]] || {
    echo "lane-push: target $target is not the checked red baseline $checked_base" >&2; exit 3; }
fi

if [[ -n "$before" ]] && ! git merge-base --is-ancestor "$before" "$sha" 2>/dev/null; then
  echo "lane-push: ОТКАЗ — вершина $target ушла на $before, её нет в истории кандидата." >&2
  echo "           Сделай ребейз на неё в этом же воркtree и вызови снова." >&2
  exit 3
fi

# Replace the checkout base with the pre-push target tip for afterLand.
# An empty value means the target does not exist; afterLand must not infer a base.
printf '%s\n' "$before" > .git/lane-base
if [[ "${DELIVERY:-}" != requirement && -n "${JOPPA_READER_COMMAND_JSON:-}${REQUIREMENT_READER_FILE:-}" ]]; then
  rc=0
  timeout --kill-after=5s 60s node "$(dirname "${BASH_SOURCE[0]}")/requirement-current.mjs" --tasks || rc=$?
  case "$rc" in 0) ;; 75|124) exit 75 ;; *) exit 1 ;; esac
fi
budget_check
timeout --kill-after=5s 60s git push origin "$sha:refs/heads/$target" || {
  echo 'lane-push: publication outcome is uncertain; inspect target ancestry' >&2; exit 4; }
after="$(timeout 15 git ls-remote origin "refs/heads/$target" 2>/dev/null | awk '{print $1}' | head -1)" || {
  echo 'lane-push: target read failed after publication; inspect target ancestry' >&2; exit 4; }
echo "lane-push: after=$after"
[[ "$after" == "$sha" ]] || { echo 'lane-push: вершина не совпала с кандидатом — проверь вручную' >&2; exit 4; }
echo "lane-push: OK $target -> $sha"
