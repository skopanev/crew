#!/usr/bin/env bash
set -euo pipefail
# Builds the lane image, handing it the HOST harness versions so it can take
# whichever is newer. Read here rather than in the Dockerfile, because a build
# cannot see the host.
cd "$(dirname "${BASH_SOURCE[0]}")"
v() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
# БАЗА: самый свежий medulla-default, который есть на машине. Медулла строит
# его сама при первом запуске с --docker; тег - отпечаток её версии.
base="${BASE_IMAGE:-$(docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
        | awk -F'\t' '$1 ~ /^medulla-default:/ {print $2"\t"$1}' | sort -r | head -1 | cut -f2)}"
[ -n "$base" ] || { echo "build-image.sh: базового образа medulla-default нет." >&2
                    echo "  Он строится медуллой при первом запуске с --docker." >&2
                    exit 2; }
# И ПРОВЕРКА, ЧТО БАЗА НЕ ОТСТАЛА: движок внутри исполняет узлы, движок снаружи
# оркестрирует. Разошлись - утверждения о шаблонах и сигналах описывают другой
# движок, а не тот, что работает.
host_m="$(medulla --version 2>/dev/null | awk '{print $2}')"
img_m="$(docker run --rm --entrypoint sh "$base" -c 'medulla --version' 2>/dev/null | awk '{print $2}')"
if [ -n "$host_m" ] && [ -n "$img_m" ] && [ "$host_m" != "$img_m" ]; then
  echo "build-image.sh: база несёт medulla $img_m, на хосте $host_m." >&2
  echo "  Обновите базу: medulla --docker --build -w <любой воркфлоу>" >&2
  echo "  Либо задайте BASE_IMAGE=<тег> явно." >&2
  exit 2
fi
echo "build-image.sh: база $base, medulla $img_m" >&2

docker build -t "${MEDULLA_IMAGE:-medulla-crew:latest}" -f Dockerfile \
  --build-arg "BASE_IMAGE=$base" \
  --build-arg "CLAUDE_HOST_VERSION=$(v claude)" \
  --build-arg "CODEX_HOST_VERSION=$(v codex)" \
  "$@" .
