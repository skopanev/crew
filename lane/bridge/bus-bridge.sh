#!/usr/bin/env bash
set -uo pipefail
# The host half of the lane's voice on the bus.
#
# The client used to live in the image. That put a full dispatcher inside a
# container whose body runs with permissions skipped: `drain`, `reply`,
# `history` and `requests` all worked, a NATS pull client sat beside them, and
# AGENTBUS_FROM is self-declared, so one `export` was enough to speak as the GM.
# A lane that can read the room it escalates into is a lane taking instructions
# from its own alarm.
#
# So nothing in the container speaks NATS. It writes a request here, and this
# decides everything that matters:
#
#   the ROOM      fixed, from LANE_BUS_ROOM - never from the request
#   the IDENTITY  fixed, from LANE_BUS_FROM - never from the request
#   the INTENT    always --fyi; a request would wait for a reply nothing in the
#                 container can read, then time out and notify twice
#   the RECIPIENT from the request, but only if it is in LANE_BUS_ALLOWED
#
# The request carries a recipient and a message. Not argv - unlike the equill
# bridge, which passes an argument vector because it serves several read-only
# verbs. Here there is one verb, and a vector would only be a way to smuggle
# flags into it.
bridge="${LANE_BUS_DIR:-${MEDULLA_BRIDGE:-/tmp/medulla-bridge}/bus}"
poll="${LANE_BUS_POLL:-0.1}"

: "${LANE_BUS_ROOM:?bus-bridge: LANE_BUS_ROOM is required}"
: "${LANE_BUS_FROM:?bus-bridge: LANE_BUS_FROM is required}"
: "${LANE_BUS_ALLOWED:?bus-bridge: LANE_BUS_ALLOWED is required}"

command -v agentbus >/dev/null 2>&1 || { echo "bus-bridge: no agentbus on PATH" >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "bus-bridge: no jq on PATH" >&2; exit 127; }
mkdir -p "$bridge/req" "$bridge/resp" || exit 1
chmod 700 "$bridge" "$bridge/req" "$bridge/resp" 2>/dev/null || true

pidfile="$bridge/bridge.pid"
if [ -f "$pidfile" ]; then
  old="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "bus-bridge: already running (pid $old)" >&2
    exit 0
  fi
fi
echo $$ > "$pidfile"
trap 'rm -f "$pidfile"; exit 0' INT TERM HUP

echo "bus-bridge listening on $bridge (pid $$), room $LANE_BUS_ROOM as $LANE_BUS_FROM"

while true; do
  found=0
  for req in "$bridge"/req/*.json; do
    [ -e "$req" ] || continue
    found=1
    id="$(basename "$req" .json)"
    to="$(jq -r '.to // ""' "$req" 2>/dev/null)"
    text="$(jq -r '.text // ""' "$req" 2>/dev/null)"
    want_room="$(jq -r '.room // ""' "$req" 2>/dev/null)"
    rm -f "$req"

    out="$bridge/resp/$id.out"; err="$bridge/resp/$id.err"; rc_f="$bridge/resp/$id.rc"
    : > "$out"; : > "$err"

    refuse=""
    # A room this bridge does not serve is a workflow bug, and delivering the
    # message elsewhere anyway would hide it.
    if [ -n "$want_room" ] && [ "$want_room" != "$LANE_BUS_ROOM" ]; then
      refuse="asked for room '$want_room'; this bridge serves $LANE_BUS_ROOM"
    fi
    [ -n "$refuse" ] || case "$to" in
      "")    refuse="no recipient" ;;
      *,*)   refuse="one recipient at a time, not a list" ;;
      all:*) refuse="broadcasting is not available to a lane" ;;
    esac
    if [ -z "$refuse" ]; then
      ok=1
      for a in $LANE_BUS_ALLOWED; do [ "$a" = "$to" ] && ok=0; done
      [ "$ok" -eq 0 ] || refuse="'$to' is not one of: $LANE_BUS_ALLOWED"
    fi
    [ -n "$text" ] || refuse="${refuse:-no message}"

    if [ -n "$refuse" ]; then
      printf '%s %-16s REFUSED: %s\n' "$(date +%H:%M:%S)" "${to:-?}" "$refuse"
    else
      printf '%s %-16s %s\n' "$(date +%H:%M:%S)" "$to" "${text:0:180}"
    fi

    if [ -n "$refuse" ]; then
      echo "bus-bridge: $refuse" > "$err"
      printf '2' > "$rc_f.tmp"
    else
      # --fyi always, identity and room from the host's environment.
      # Two braces in a row make the bus try to render the BODY as its own
      # template: the recipient gets mangled text and the sender sees only
      # "Could not parse body template". A lane substitutes model output and
      # journal text into these messages and controls neither, so it is defused
      # here, once, for every node.
      safe_text="$(printf '%s' "$text" | sed 's/{{/{ {/g; s/}}/} }/g')"
      AGENTBUS_FROM="$LANE_BUS_FROM" \
        agentbus send "$LANE_BUS_ROOM" --to "$to" --fyi "$safe_text" > "$out" 2> "$err"
      rc=$?
      # RC 0 is not delivery. The client exits 0 when the script ran; what says
      # the bus TOOK it is inbox_STORED in the output. Without this check a bus
      # that silently dropped everything would have looked like success.
      # The field must be non-EMPTY, not merely present. Measured: an unknown
      # recipient makes the client print "unknown recipients: ..." and exit 1, so
      # that case is caught by rc alone - but `inbox_STORED=` with nothing after
      # it would satisfy a bare grep, and a delivery check that can be satisfied
      # by an empty answer is not a check.
      if [ "$rc" -eq 0 ] && ! grep -q 'inbox_STORED=[^[:space:]]' "$out"; then
        echo "bus-bridge: agentbus returned 0 but the bus did not store it" >> "$err"
        rc=3
      fi
      printf '%s' "$rc" > "$rc_f.tmp"
    fi
    mv -f "$rc_f.tmp" "$rc_f"
  done
  # Sweep answers nobody collected: a caller that timed out leaves its .out/.err
  # behind, and the directory would grow for the life of the daemon.
  find "$bridge/resp" -type f -mmin +10 -delete 2>/dev/null || true
  [ "$found" -eq 1 ] || sleep "$poll"
done
