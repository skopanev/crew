#!/usr/bin/env bash
set -euo pipefail
target="$1"
source_json="${2:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${TOOLING_ROOT:=$(cd "$here/../../.." && pwd)}"

# Источник обязателен. Запасная ветка указывала на codex-hooks.json, который
# ссылался на старый company/lane-memory-hook.sh абсолютным путём хоста и
# никогда не вызывался: узлы передают источник явно.
[ -n "$source_json" ] || { echo "inject.sh: не указан источник настроек" >&2; exit 1; }
[[ -f "$source_json" ]] || { echo "inject.sh: no such source: $source_json" >&2; exit 1; }

title="Ticket ${ticket_id:-UNKNOWN}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

jq --arg title "$title" --arg root "$TOOLING_ROOT" '
  def retarget:
    if type == "object" and .type == "command" and (.command | type == "string")
    then .command |= sub("^.*?(?<tail>lane/[^\\s]*\\.sh)"; "bash \($root)/\(.tail)")
    else . end;
  def retitle:
    if type == "object" and .type == "mcp_tool" then .input.query = $title else . end;
  (.hooks // {}) |= (
    to_entries
    | map(.value |= map(.hooks |= map(retarget | retitle)))
    | from_entries
  )
' "$source_json" > "$tmp"

case "${LANE_PATH+set}" in
  set)
    if [ "$LANE_PATH" = "inherit" ]; then
      jq 'if has("env") then .env |= del(.PATH) else . end' "$tmp" > "$target"
    else
      jq --arg p "$LANE_PATH" '.env.PATH = $p' "$tmp" > "$target"
    fi
    ;;
  *) cp "$tmp" "$target" ;;
esac
