#!/bin/sh
set -u
# What answers to `agentbus` inside the container. It speaks no NATS: the whole
# client, the pull primitive and the self-declared identity are gone from the
# image, so reading the bus and speaking under another name are not refused
# here - they are absent.
#
# The only shape accepted is the one the workflow uses:
#
#   agentbus send <room> --to <alias> --fyi <text>
#
# and even that is checked again on the host, which is where the decision
# actually lives. The room IS sent, so the host can compare it with the one it
# serves and REFUSE a mismatch: silently redirecting a message to a different
# room would hide a workflow asking for the wrong one. Identity, intent and who
# may be written to are the host's alone, so nothing here can argue with them.
#
# Exit 127 is the contract with the caller, as with the equill shim: it means
# "no bus here", and the notification nodes report that rather than pretending.
bridge="${LANE_BUS_DIR:-${MEDULLA_BRIDGE:-/tmp/medulla-bridge}/bus}"
timeout_s="${LANE_BUS_TIMEOUT:-30}"

give_up() { echo "agentbus(lane): $1" >&2; exit 127; }
refuse()  { echo "agentbus(lane): $1" >&2; exit 2; }

[ "${1:-}" = "send" ] || refuse "only 'send' exists here, not '${1:-<nothing>}'"
shift
room="${1:-}"; [ $# -gt 0 ] && shift

to=""; text=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to)  to="${2:-}"; shift 2 ;;
    --fyi) shift ;;
    --*)   refuse "flag '$1' is not available here" ;;
    *)     [ -z "$text" ] || refuse "one message, not several"
           text="$1"; shift ;;
  esac
done
[ -n "$to" ]   || refuse "no recipient"
[ -n "$text" ] || refuse "no message"

[ -d "$bridge/req" ] || give_up "no bridge at $bridge - nothing is listening"

id="lane-$$-$(date +%s)-$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
tmp="$bridge/req/.$id.tmp"
# jq builds it: a message carries quotes and newlines, and hand-built JSON
# breaks on the first one of them.
jq -nc --arg to "$to" --arg text "$text" --arg room "$room" \
   '{to:$to,text:$text,room:$room}' > "$tmp" 2>/dev/null \
  || give_up "could not compose the request"
# Renamed into place, so the daemon never reads a half-written request.
mv -f "$tmp" "$bridge/req/$id.json" 2>/dev/null || give_up "could not queue the request"

# Withdraw the request on the way out. Abandoning it left the file in the queue,
# so the daemon delivered it AFTER the caller had already reported "could not
# reach the bus" - the GM got the failure notice first and the message it was
# about second.
waited=0
while [ ! -f "$bridge/resp/$id.rc" ]; do
  waited=$((waited + 1))
  if [ "$waited" -ge $((timeout_s * 10)) ]; then
    rm -f "$bridge/req/$id.json" "$bridge/resp/$id.out" "$bridge/resp/$id.err" 2>/dev/null
    give_up "no answer in ${timeout_s}s"
  fi
  sleep 0.1
done

rc="$(cat "$bridge/resp/$id.rc" 2>/dev/null || echo 127)"
[ -s "$bridge/resp/$id.out" ] && cat "$bridge/resp/$id.out"
[ -s "$bridge/resp/$id.err" ] && cat "$bridge/resp/$id.err" >&2
rm -f "$bridge/resp/$id.out" "$bridge/resp/$id.err" "$bridge/resp/$id.rc"
exit "$rc"
