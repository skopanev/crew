#!/usr/bin/env bash
set -uo pipefail
bridge="${MEDULLA_BRIDGE:-/tmp/medulla-bridge}/equill"
equill_bin="${EQUILL_BIN:-equill}"
poll="${EQUILL_BRIDGE_POLL:-0.1}"

# CLI verbs, not MCP tool names. schema_list/schema_show stood here and are not
# equill subcommands at all - the CLI has one `schema` with list/show under it -
# so reading the store's schema was refused outright. --help and --version are
# introspection: two agents in one run asked for help and the bridge refused,
# which is the opposite of giving them the tool.
allowed_verbs="context search"

# ИМЯ ЧИТАТЕЛЯ - У МОСТА, НЕ У ЗАПРОСА. Прослойка шлёт только argv, окружение
# через границу не едет; equill же берёт актора ТОЛЬКО из окружения и падает до
# чтения стора, если его нет. Требуем здесь, как bus-bridge требует свой
# LANE_BUS_FROM: подделать личность из контейнера тогда нечем.
: "${EQUILL_ACTOR:?equill-bridge: EQUILL_ACTOR is required}"
export EQUILL_ACTOR
command -v "$equill_bin" >/dev/null 2>&1 || { echo "equill-bridge: no equill on PATH" >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "equill-bridge: no jq on PATH" >&2; exit 127; }
mkdir -p "$bridge/req" "$bridge/resp" || exit 1
chmod 700 "$bridge" "$bridge/req" "$bridge/resp" 2>/dev/null || true

pidfile="$bridge/bridge.pid"
if [ -f "$pidfile" ]; then
  old="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "equill-bridge: already running (pid $old)" >&2
    exit 0
  fi
fi
echo $$ > "$pidfile"
trap 'rm -f "$pidfile"; exit 0' INT TERM HUP

echo "equill-bridge listening on $bridge (pid $$)"

while true; do
  found=0
  for req in "$bridge"/req/*.json; do
    [ -e "$req" ] || continue
    found=1
    id="$(basename "$req" .json)"

    argv=()
    while IFS= read -r b64; do argv+=("$(printf %s "$b64" | base64 -d)"); done \
      < <(jq -r '.argv[]? | @base64' "$req" 2>/dev/null)
    rm -f "$req"

    # What was actually asked, not just which verb. A --query is the whole point
    # of the call; coordinates are what a baseline asks by instead.
    ask=""; take=""
    for a in "${argv[@]}"; do
      # equill takes --coordinate SEPARATED from its value, so the value is the
      # NEXT argument, not part of this one. The first version only handled the
      # attached --query=... form and logged a baseline as an empty request.
      case "$take" in
        coord) ask="${ask:+$ask }[$a]"; take="" ; continue ;;
        prof)  ask="${ask:+$ask }<$a>"; take="" ; continue ;;
      esac
      case "$a" in
        --query=*)   ask="${a#--query=}" ;;
        --coordinate) take=coord ;;
        --profile)   take=prof ;;
      esac
    done
    printf '%s %-8s request: "%s"\n' "$(date +%H:%M:%S)" "${argv[0]:-?}" "${ask:0:220}"
    out="$bridge/resp/$id.out"; err="$bridge/resp/$id.err"; rc_f="$bridge/resp/$id.rc"
    if [ ${#argv[@]} -eq 0 ]; then
      : > "$out"; echo "equill-bridge: empty argv" > "$err"; printf '2' > "$rc_f.tmp"
    elif ! printf '%s\n' $allowed_verbs | grep -qxF -- "${argv[0]}"; then
      : > "$out"
      echo "equill-bridge: refused verb '${argv[0]}' (this bridge is read-only)" > "$err"
      printf '2' > "$rc_f.tmp"
    else
      "$equill_bin" "${argv[@]}" > "$out" 2> "$err"
      printf '%s' "$?" > "$rc_f.tmp"
    fi

    mv -f "$rc_f.tmp" "$rc_f"
  done
  [ "$found" -eq 1 ] || sleep "$poll"
done
