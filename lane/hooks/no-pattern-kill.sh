#!/usr/bin/env bash
# Refuse pattern kills in lanes. `pkill -f PATTERN` and `killall` also match the
# agent's own argv (its prompt names the same scripts), so the agent kills itself
# and the lane exits 130 with the ticket left in_progress (10-12: three lanes).
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
if grep -qE '(^|[^[:alnum:]_])(pkill[[:space:]][^;&|]*-[a-zA-Z]*f[a-zA-Z]*|killall)([[:space:]]|$)' <<<"$cmd"; then
  echo 'Refused: pkill -f / killall match your own process and end the lane. Kill only the PID you started: save $! when you launch it (cmd & pid=$!; ... kill $pid).' >&2
  exit 2
fi
exit 0
