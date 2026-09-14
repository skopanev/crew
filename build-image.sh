#!/usr/bin/env bash
set -euo pipefail
# Всё, что внутри образа, пришпилено в Dockerfile и собирается одинаково у
# любого. Здесь остаётся ЕДИНСТВЕННОЕ, чего сборка знать не может: какой
# коммит движка стоит на ЭТОЙ машине.
#
# Снаружи медулла оркестрирует, внутри - исполняет узлы. Разойдутся - и всё,
# что замерено про шаблоны и сигналы, описывает не тот движок, который
# работает. run.sh сверяет пару ещё раз перед запуском, потому что образ может
# пролежать несобранным, пока хост ушёл вперёд.
cd "$(dirname "${BASH_SOURCE[0]}")"
commit_file="${MEDULLA_HOME:-$HOME/.medulla}/engine/INSTALLED_COMMIT"
ref="${MEDULLA_REF:-$( [ -r "$commit_file" ] && awk '{print $1}' "$commit_file" )}"
[ -n "$ref" ] || { echo "build-image.sh: коммит движка не определился ($commit_file)." >&2
                   echo "  Задайте MEDULLA_REF=<коммит|ветка> явно." >&2; exit 2; }

docker build -t "${MEDULLA_IMAGE:-medulla-crew:latest}" -f Dockerfile \
  --build-arg "MEDULLA_REF=$ref" "$@" .
