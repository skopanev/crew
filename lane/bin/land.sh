#!/usr/bin/env bash
# Land a clean, reviewed candidate using native hooks and a normal push.
# Refuse a diverged target; verify its final SHA.
set -euo pipefail
usage() { echo 'land.sh <target-branch>'; }
[[ $# -eq 1 && "$1" != -h && "$1" != --help ]] || { usage; exit 2; }
target="$1"
[[ "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "lane-push: недопустимая ветка: $target" >&2; exit 2; }

git rev-parse --git-dir >/dev/null 2>&1 || { echo 'lane-push: не репозиторий' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || {
  echo 'lane-push: рабочее дерево грязное — сначала сохрани работу, пуш незакоммиченного не бывает' >&2; exit 2; }

sha="$(git rev-parse HEAD)"
python3 "$(dirname "${BASH_SOURCE[0]}")/gates.py" verify
before="$(git ls-remote origin "refs/heads/$target" 2>/dev/null | awk '{print $1}' | head -1)"
echo "lane-push: HEAD=$sha target=$target before=${before:-<ветки нет>}"

if [[ -n "$before" ]] && ! git merge-base --is-ancestor "$before" "$sha" 2>/dev/null; then
  echo "lane-push: ОТКАЗ — вершина $target ушла на $before, её нет в истории кандидата." >&2
  echo "           Сделай ребейз на неё в этом же воркtree и вызови снова." >&2
  exit 3
fi

git push origin "$sha:refs/heads/$target"
after="$(git ls-remote origin "refs/heads/$target" 2>/dev/null | awk '{print $1}' | head -1)"
echo "lane-push: after=$after"
[[ "$after" == "$sha" ]] || { echo 'lane-push: вершина не совпала с кандидатом — проверь вручную' >&2; exit 4; }
echo "lane-push: OK $target -> $sha"
