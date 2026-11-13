#!/usr/bin/env bash
set -uo pipefail
# The AGY adapter of the lane memory hook. The event name comes as $1: AGY 1.5.1 sends none.
#
#   PreToolUse     records the call for this conversation. AGY tool hooks cannot add
#                  context, so nothing is retrieved or marked here.
#   PreInvocation  takes the recorded calls and asks memory-hook.sh once, as a Claude
#                  PreToolUse batch. Its context stays in the conversation as a message
#                  that starts with "Joppa memory:", because each lesson is delivered once.
#   Stop           removes the record and lets the agent stop.
#
# Every other reply is {}: the hook makes no permission decision.
# memory-hook.sh keeps the query, the Joppa read and the lesson deduplication.
event="${1:-}"
jq_bin="${JQ_BIN:-jq}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input="$(cat 2>/dev/null || true)"
reply() { echo '{}'; }

conversation="$("$jq_bin" -r '.conversationId // empty' <<<"$input" 2>/dev/null || true)"
[[ -n "$conversation" ]] || { reply; exit 0; }
key="$(CONVERSATION="$conversation" python3 -c '
import hashlib, json, os
scope = [os.environ.get(k, "") for k in ("MEDULLA_RUN_DIR", "LANE_MEMORY_CONFIG", "LANE_MEMORY_ROLE",
                                         "LANE_MEMORY_PROCESS", "LANE_MEMORY_TICKET", "CONVERSATION")]
print(hashlib.sha256(json.dumps(scope).encode()).hexdigest())')"
calls="${TMPDIR:-/tmp}/lane-agy-calls.$key"

# One locked file per conversation holds at most the last 10 calls. take empties it.
record() {
  ACTION="$1" CALLS="$calls" python3 -c '
import fcntl, json, os, sys
os.umask(0o077)
with open(os.environ["CALLS"], "a+", encoding="utf-8") as cache:
    fcntl.flock(cache, fcntl.LOCK_EX)
    cache.seek(0)
    try: kept = json.load(cache)
    except ValueError: kept = []
    if os.environ["ACTION"] == "add":
        call = json.load(sys.stdin).get("toolCall") or {}
        kept = (kept + [{"tool_use_id": call.get("id"), "tool_name": call.get("name", ""),
                         "tool_input": call.get("args") or {}}])[-10:]
    else:
        print(json.dumps(kept))
        kept = []
    cache.seek(0)
    cache.truncate()
    json.dump(kept, cache)
'
}

case "$event" in
  PreToolUse) record add <<<"$input" >/dev/null 2>&1 || true ;;
  PreInvocation)
    taken="$(record take </dev/null 2>/dev/null || echo '[]')"
    if [[ "$("$jq_bin" 'length' <<<"$taken" 2>/dev/null || echo 0)" != 0 ]]; then
      claude="$("$jq_bin" -cn --arg s "$conversation" --argjson calls "$taken" \
        --arg t "$("$jq_bin" -r '.transcriptPath // empty' <<<"$input")" \
        '{hook_event_name: "PreToolUse", session_id: $s, transcript_path: $t, tool_calls: $calls}')"
      bash "$here/memory-hook.sh" <<<"$claude" | "$jq_bin" -ce '
        [.hookSpecificOutput.additionalContext?, .systemMessage?]
        | map(select(type == "string" and test("\\S"))) | join("\n\n")
        | if . == "" then {} else {injectSteps: [{userMessage: ("Joppa memory:\n" + .)}]} end' 2>/dev/null && exit 0
    fi ;;
  Stop) rm -f -- "$calls" ;;
esac
reply
