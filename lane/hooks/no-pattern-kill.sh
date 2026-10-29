#!/usr/bin/env bash
# Refuse pattern kills in lanes. `pkill -f PATTERN` matches whole command lines, and the
# coder agent's own command line names the same scripts, so the agent ends itself
# (2026-10-12: three lanes exited 130 with the Task left in progress). `killall NAME`
# stops every process with that name, which can include the agent's own runtime.
# Only a command word counts: text inside echo or a quoted message passes.
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
word='(^|[;&|(`]|\$\()[[:space:]]*(sudo[[:space:]]+)?'
if grep -qE "${word}(pkill([[:space:]]+-[^[:space:];&|]*)*[[:space:]]+-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|\$)|killall([[:space:]]|\$))" <<<"$cmd"; then
  echo 'Refused: stop only a process that you started, with its saved PID: cmd & pid=$!; ...; kill "$pid".' >&2
  exit 2
fi
exit 0
