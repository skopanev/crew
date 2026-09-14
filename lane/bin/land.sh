#!/usr/bin/env bash
# Landing for the container lane. COPIED from company/lane-push.sh on 2026-09-11
# and owned here from that point: the old scripts change on their own schedule -
# GM patched lane-management.sh today - and a workflow that borrows a file
# inherits those changes unannounced. The original keeps serving the old lanes.
#
# The guarantees below are the reason it is copied rather than rewritten: force
# is impossible by construction, --no-verify does not appear, a dirty tree is
# refused, and a diverged target is refused with a rebase instruction instead of
# a force.
set -euo pipefail
# Пуш полосы одной командой: обёртка с гарантиями, которых у сырого `git push`
# нет. Форс НЕВОЗМОЖЕН по построению — рефспек собирается внутри и аргументы
# наружу не передаются, так что передать --force нечем. Гейты не обходятся:
# --no-verify здесь нет. Отказ на грязном дереве. Отказ, когда вершина цели
# ушла и её нет в истории кандидата — с указанием сделать ребейз, как требует
# tickets.lane.11, а не форс. Печатает вершину до и после: это то доказательство
# приземления, которое иначе приходится собирать вручную.
#
# ЧЕМ ЭТОТ СКРИПТ НЕ ЯВЛЯЕТСЯ: обходом нативного отказа. Первая редакция этой
# шапки заявляла ровно это, и PM проекта справедливо отказался её запускать.
# Разрешено ли полосе публиковать наружу — решает владелец, и никакая обёртка
# этого решения не заменяет. Скрипт делает пуш БЕЗОПАСНЕЕ там, где он уже
# разрешён; он не делает его разрешённым.
usage() { echo 'lane-push.sh <target-branch>'; }
[[ $# -eq 1 && "$1" != -h && "$1" != --help ]] || { usage; exit 2; }
target="$1"
[[ "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "lane-push: недопустимая ветка: $target" >&2; exit 2; }

git rev-parse --git-dir >/dev/null 2>&1 || { echo 'lane-push: не репозиторий' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || {
  echo 'lane-push: рабочее дерево грязное — сначала сохрани работу, пуш незакоммиченного не бывает' >&2; exit 2; }

sha="$(git rev-parse HEAD)"
before="$(git ls-remote origin "refs/heads/$target" 2>/dev/null | awk '{print $1}' | head -1)"
echo "lane-push: HEAD=$sha target=$target before=${before:-<ветки нет>}"

# Кандидат должен содержать текущую вершину. Иначе это перезапись чужой работы,
# и лечится ребейзом (tickets.lane.11), а не форсом.
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
