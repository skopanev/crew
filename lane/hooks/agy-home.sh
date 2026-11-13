#!/usr/bin/env bash
# AGY in the lane container: its sign-in and its memory hooks, both in the private $HOME.
#
# AGY reads only $HOME/.gemini. A missing or unusable token is prepared once through
# broker-agy in this same HOME; a failure is reported and the AGY reviewer fails as before.
# The memory hooks are wired only when the selected settings run memory-hook.sh before
# tool calls. Other custom commands of those settings are not translated for AGY.
set -euo pipefail
settings="${1:?source settings json required}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${TOOLING_ROOT:=$(cd "$here/../.." && pwd)}"

token="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
usable() { jq -e 'type == "object" and (.token | type) == "object"' "$token" >/dev/null 2>&1; }
if ! usable; then
  if command -v broker-agy >/dev/null 2>&1 \
     && BROKER_AGY_HOME="$HOME" timeout 20s broker-agy models >/dev/null 2>&1 && usable; then
    echo 'agy-home.sh: AGY sign-in prepared through Broker' >&2
  else
    echo 'agy-home.sh: AGY sign-in unavailable; the AGY reviewer will fail' >&2
  fi
fi

jq -e '[.hooks.PreToolUse[]?.hooks[]?.command | strings | select(test("memory-hook\\.sh"))] | length > 0' \
  "$settings" >/dev/null || { echo 'agy-home.sh: selected settings run no memory query; AGY hooks off' >&2; exit 0; }
hooks="$HOME/.gemini/config/hooks.json"
wanted="$(jq -n --arg h "$TOOLING_ROOT/lane/hooks/agy-memory.sh" '
  def run(e; t): {type: "command", command: "bash \($h) \(e)", timeout: t};
  {"crew-lane-memory": {PreToolUse: [{matcher: ".*", hooks: [run("PreToolUse"; 10)]}],
    PreInvocation: [run("PreInvocation"; 40)], Stop: [run("Stop"; 10)]}}')"
if [[ -e "$hooks" ]]; then
  jq -e --argjson w "$wanted" '. == $w' "$hooks" >/dev/null 2>&1 \
    || { echo "agy-home.sh: $hooks exists with other hooks; refused" >&2; exit 1; }
  exit 0
fi
mkdir -p "$(dirname "$hooks")"
printf '%s\n' "$wanted" > "$hooks"
