#!/usr/bin/env bash
set -euo pipefail
# Собирает образ полосы. Базового образа НЕТ - ни медуллы, ни чужого: всё, что
# внутри, ставится здесь и видно в Dockerfile. Версии читаются с хоста, потому
# что сборка хост не видит.
cd "$(dirname "${BASH_SOURCE[0]}")"
v() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

# ДВИЖОК БЕРЁТСЯ КОММИТОМ, А НЕ "ПОСЛЕДНИМ". Снаружи движок оркестрирует,
# внутри - исполняет узлы. Разошлись - и всё, что замерено про шаблоны и
# сигналы, описывает не тот движок, который работает. Коммит хоста лежит в
# INSTALLED_COMMIT; "main" оставлен только на случай, когда файла нет.
commit_file="${MEDULLA_HOME:-$HOME/.medulla}/engine/INSTALLED_COMMIT"
ref="${MEDULLA_REF:-$( [ -r "$commit_file" ] && awk '{print $1}' "$commit_file" )}"
[ -n "$ref" ] || { echo "build-image.sh: коммит движка не определился ($commit_file)." >&2
                   echo "  Задайте MEDULLA_REF=<коммит|ветка> явно." >&2; exit 2; }
# ХАРНЕССЫ: БЕРЁТСЯ СТАРШАЯ ИЗ ДВУХ, а не просто хостовая. Замер: на хосте
# claude 2.1.236, а в прежнем образе 2.1.268 - и --strict-mcp-config режет
# хостовые MCP-серверы с 2.1.268 и НЕ режет на 2.1.236. "Как на хосте" откатило
# бы полосу ровно в то поведение, на отсутствии которого держится вся изоляция.
# Пол поднимается здесь, руками, после того как на нём прогнали полосу.
CLAUDE_MIN=2.1.270
CODEX_MIN=0.154.0
newer() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }
claude_v="$(newer "$(v claude)" "$CLAUDE_MIN")"
codex_v="$(newer "$(v codex)" "$CODEX_MIN")"
echo "build-image.sh: medulla $(v medulla) @ $ref, claude $claude_v, codex $codex_v" >&2

docker build -t "${MEDULLA_IMAGE:-medulla-crew:latest}" -f Dockerfile \
  --build-arg "MEDULLA_REF=$ref" \
  --build-arg "CLAUDE_VERSION=$claude_v" \
  --build-arg "CODEX_VERSION=$codex_v" \
  "$@" .
