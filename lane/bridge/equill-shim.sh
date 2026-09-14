#!/usr/bin/env bash
set -uo pipefail
bridge="${EQUILL_BRIDGE:-/tmp/medulla-bridge/equill}"
timeout_s="${EQUILL_BRIDGE_TIMEOUT:-40}"

case "${1:-}" in
  --version|-V)
    [ -d "$bridge/req" ] && { echo "equill (host bridge)"; exit 0; }
    echo "equill: bridge not mounted" >&2; exit 127 ;;
esac

if [ ! -d "$bridge/req" ] || [ ! -d "$bridge/resp" ]; then
  echo "equill: host bridge not mounted at $bridge" >&2
  exit 127
fi
if [ ! -f "$bridge/bridge.pid" ]; then
  echo "equill: host bridge is not running (no bridge.pid)" >&2
  exit 127
fi

command -v jq >/dev/null 2>&1 || { echo "equill: jq missing in image" >&2; exit 127; }

id="$$-${RANDOM}-${RANDOM}"
req="$bridge/req/$id.json"

if ! jq -nc '{argv: $ARGS.positional}' --args -- "$@" > "$req.part" 2>/dev/null; then
  rm -f "$req.part"
  echo "equill: could not encode arguments" >&2
  exit 127
fi
mv -f "$req.part" "$req"

waited=0
while [ ! -f "$bridge/resp/$id.rc" ]; do
  sleep 0.1
  waited=$((waited + 1))
  if [ "$waited" -ge $((timeout_s * 10)) ]; then
    rm -f "$req"
    echo "equill: host bridge did not answer in ${timeout_s}s" >&2
    exit 127
  fi
done

[ -f "$bridge/resp/$id.out" ] && cat "$bridge/resp/$id.out"
[ -f "$bridge/resp/$id.err" ] && cat "$bridge/resp/$id.err" >&2
rc="$(cat "$bridge/resp/$id.rc" 2>/dev/null)"
rm -f "$bridge/resp/$id.out" "$bridge/resp/$id.err" "$bridge/resp/$id.rc"
case "$rc" in
  ''|*[!0-9]*) exit 127 ;;
  *) exit "$rc" ;;
esac
