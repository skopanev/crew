#!/usr/bin/env bash
# Приватный CODEX_HOME для узла полосы: хуки и MCP.
#
# Кодекс не принимает --settings: его хуки живут в $CODEX_HOME/hooks.json, а
# серверы MCP - в config.toml. Формат хуков ТОТ ЖЕ, что у claude, поэтому
# memory-hook.sh общий на оба харнесса и ветвить его не нужно.
#
# Флот делает то же самое в company/codex-pane-home.sh, но там дом на роль и
# на панель; здесь дом на УЗЕЛ и живёт ровно один прогон.
set -euo pipefail
home="${1:?CODEX_HOME required}"
settings="${2:?source settings json required}"
mkdir -p "$home" && chmod 700 "$home"

# Хуки: берём те же события из общего файла настроек. jq, а не cp - у claude
# файл несёт ещё permissions и env, кодексу они не нужны и он на них ругается.
# И СОПОСТАВИТЕЛЬ PreToolUse РАСШИРЯЕТСЯ ДО ВСЕОХВАТНОГО. У claude там стоит
# "Bash" - имя ЕГО инструмента. Кодекс зовёт оболочку иначе (в расшифровке это
# command_execution), поэтому по "Bash" хук не срабатывал ни разу: замер на
# прогоне 2cc48395 - 18 команд оболочки у разведчика и НОЛЬ переписанных в rtk,
# при том что правило tools.rtk уровня must висит в контракте.
jq '{hooks}' "$settings" \
  | jq '(.hooks.PreToolUse[]?.matcher) |= "*"' > "$home/hooks.json"

# У кодекса нет своего процессора rtk, но вход PreToolUse у него того же вида,
# что у claude - tool_name и tool_input, - поэтому годится процессор claude.

# MCP: у кодекса своё место. Те же два сервера, что в mcp.json для claude.
# ОКРУЖЕНИЕ СЕРВЕРАМ НАДО ОТДАТЬ ЯВНО. Кодекс запускает MCP-сервер сам и не
# передаёт ему переменные узла: в прогоне eead888a search_code и search_graph
# отработали, но оба вернули "project not found or not indexed" - сервер
# стартовал без CBM_CACHE_DIR и не нашёл хранилища. У claude того же не
# случилось, потому что он отдаёт серверу своё окружение целиком.
cat > "$home/config.toml" <<TOML
[mcp_servers.codebase-memory]
command = "/usr/local/bin/codebase-memory-mcp"
env = { CBM_CACHE_DIR = "${CBM_CACHE_DIR:-}", CBM_ALLOWED_ROOT = "${CBM_ALLOWED_ROOT:-/workspace}" }

[mcp_servers.ntk]
command = "/usr/local/bin/ntk"
args = ["mcp"]
TOML
