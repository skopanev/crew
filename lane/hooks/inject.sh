#!/usr/bin/env bash
set -euo pipefail
target="$1"
source_json="${2:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${TOOLING_ROOT:=$(cd "$here/../.." && pwd)}"
default_json="$here/claude-settings.json"
configured_json="${LANE_HOOKS_CONFIG:-}"
if [[ -n "$configured_json" && ( -z "$source_json" || "$source_json" == "$TOOLING_ROOT/lane/hooks/claude-settings.json" || "$source_json" == "$default_json" ) ]]; then
  source_json="$configured_json"
fi

# Источник обязателен. Запасная ветка указывала на codex-hooks.json, который
# ссылался на старый company/lane-memory-hook.sh абсолютным путём хоста и
# никогда не вызывался: узлы передают источник явно.
[ -n "$source_json" ] || { echo "inject.sh: не указан источник настроек" >&2; exit 1; }
[[ -f "$source_json" ]] || { echo "inject.sh: no such source: $source_json" >&2; exit 1; }
[[ -f "$default_json" ]] || { echo "inject.sh: no such default settings: $default_json" >&2; exit 1; }

title="Ticket ${ticket_id:-UNKNOWN}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

jq --slurpfile defaults "$default_json" --arg title "$title" --arg root "$TOOLING_ROOT" '
  def ordered_union($a; $b):
    reduce (($a // []) + ($b // []))[] as $item ([]; if index($item) then . else . + [$item] end);
  def retarget:
    if type == "object" and .type == "command" and (.command | type == "string")
    then .command |= (
      if test("^(?:/usr/bin/env\\s+bash\\s+|bash\\s+)?<TOOLING_ROOT>/")
      then sub("^(?:/usr/bin/env\\s+bash\\s+|bash\\s+)?<TOOLING_ROOT>/"; "bash \($root)/")
      else gsub("<TOOLING_ROOT>"; $root) end
    )
    else . end;
  def retitle:
    if type == "object" and .type == "mcp_tool" then .input.query = $title else . end;
  ($defaults[0] // {}) as $base
  | ($base + . + {
      env: (($base.env // {}) + (.env // {})),
      permissions: (
        ($base.permissions // {}) + (.permissions // {}) + {
          allow: ordered_union($base.permissions.allow; .permissions.allow),
          deny: ordered_union($base.permissions.deny; .permissions.deny)
        }
      ),
      hooks: (
        (.hooks // {})
        | to_entries
        | map(.value |= map(.hooks |= map(retarget | retitle)))
        | from_entries
      )
    })
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
