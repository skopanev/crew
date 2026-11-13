#!/usr/bin/env bash
set -uo pipefail
# The lane's memory hook. Self-contained: nothing here reaches into company/.
#
#   SessionStart      the contract from Joppa, once, without a query
#                     (LANE_MEMORY_SESSION=off: the caller supplies the contract)
#   UserPromptSubmit  retrieval on the user's actual message
#   PostToolUse     retrieval on what just happened, before the next model call
#   Stop              the process's own ending text when the signal is missing
#
# Why the third one exists, counted on run 2026-09-11_11-21-28: implement_code
# made 100 model calls and 99 of them carried tool_use. SessionStart and
# UserPromptSubmit together reach exactly one of those 100.
#
# Every read goes through joppa-data.sh and LANE_MEMORY_CONFIG. The kinds, filters
# and fields are configuration; this file names none of them.
jq_bin="${JQ_BIN:-jq}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${LANE_MEMORY_DATA:-$here/joppa-data.sh}"

input="$(cat 2>/dev/null || true)"
event="$("$jq_bin" -r '.hook_event_name // empty' <<<"$input" 2>/dev/null || true)"

# The event log survives the container: MEDULLA_RUN_DIR is mounted from the host.
# It answers which events reach a non-interactive run at all.
printf '%s\n' "${event:-NO_NAME}" >> "${MEDULLA_RUN_DIR:-/tmp}/hook-events.log" 2>/dev/null || true

if [[ "$event" == PreToolUse ]]; then
  if "$jq_bin" -e '.tool_name == "Bash" and .tool_input.run_in_background == true' <<<"$input" >/dev/null 2>&1; then
    "$jq_bin" -cn '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",
      permissionDecisionReason:"Run commands in the foreground. Wait for their results before the final signal."}}'
  fi
  exit 0
fi

emit() {
  "$jq_bin" -cn --arg e "$1" --arg c "$2" --arg w "${3:-}" \
    '{hookSpecificOutput:{hookEventName:$e,additionalContext:$c}}
     + if $w == "" then {} else {systemMessage:$w} end'
}
emit_fatal() {
  "$jq_bin" -cn --arg e "$1" --arg m "$2" \
    '{continue:false,stopReason:$m,systemMessage:$m,
      hookSpecificOutput:{hookEventName:$e,additionalContext:""}}'
}
quiet() { emit "${event:-Unknown}" ""; exit 0; }

err="$(mktemp "${TMPDIR:-/tmp}/lane-memory.XXXXXX")"
trap 'rm -f -- "$err"' EXIT

# The text is rendered by the same adapter that reads it.
render() { bash "$data" render "$1"; }
block_fields() { "$jq_bin" -c --arg m "$1" '.[$m].fields // []' "$LANE_MEMORY_CONFIG"; }

# ── STOP: no release without a signal ───────────────────────────────────────
# A reminder per tool is statistical. Stop is the only deterministic point: it fires
# when the agent believes the work is done and can refuse, which makes it continue.
# Measured: the coder worked 12 minutes, made 10 edits and 2 new files, exited zero
# without the tag, and the node went to __default__ with all of that work.
# stop_hook_active guards the loop: the refusal is given exactly once.
if [[ "$event" == Stop ]]; then
  active="$("$jq_bin" -r '.stop_hook_active // false' <<<"$input" 2>/dev/null || echo false)"

  # Check only the latest assistant message. Contracts and older turns are not results.
  tagged=""
  tp="$("$jq_bin" -r '.transcript_path // empty' <<<"$input" 2>/dev/null || true)"
  if [[ -n "$tp" && -r "$tp" ]]; then
    "$jq_bin" -ne '
      def assistant:
        if .type == "assistant" then .message
        elif .type == "response_item" and .payload.type == "message" and .payload.role == "assistant" then .payload
        elif .message.role == "assistant" then .message else null end;
      reduce inputs as $row ("";
        ($row | assistant) as $message |
        if $message == null then . else
          if ($message.content | type) == "string" then $message.content else
            [$message.content[]? | select(.type == "text" or .type == "output_text") | .text] | join("\n")
          end
        end) | test("<signal:([A-Z_]+)>[\\s\\S]*</signal:\\1>")
    ' "$tp" >/dev/null 2>&1 && tagged=1
  fi
  [[ -z "$tagged" && "$active" != true ]] || quiet

  # The process is read again here, next to the decision, not taken from the start of
  # the transcript. Its ending field is the message: the requirement, the form and the
  # outcome names are written there once. Without it the hook says why, and invents
  # no signal rule of its own.
  # Only items that carry the field count; several ending texts are refused, not picked from.
  if reply="$(bash "$data" stop 2>"$err")"; then
    field="$("$jq_bin" -r '.stop.field' "$LANE_MEMORY_CONFIG")"
    reason="$("$jq_bin" -r --arg f "$field" '
      [.items[] | select((.[$f] | type) == "string" and .[$f] != "")] as $found
      | if ($found | length) == 1 then $found[0][$f]
        elif ($found | length) == 0 then "lane memory: stop text unavailable: no item has \($f)"
        else "lane memory: stop text unavailable: several items have \($f): "
             + ($found | map(.address // .title // "?") | join(", ")) end' <<<"$reply")"
  else
    reason="lane memory: stop text unavailable: $(cat "$err")"
  fi
  "$jq_bin" -cn --arg r "$reason" '{decision:"block",reason:$r}'
  exit 0
fi

case "$event" in SessionStart|UserPromptSubmit|PostToolUse|PostToolBatch) ;; *) quiet ;; esac

# ── SessionStart: the contract ───────────────────────────────────────────────
# A lane without its contract must not run: it would work confidently under rules it
# never read. A missing config, a refused request, a 422 and an empty reply all stop it.
if [[ "$event" == SessionStart ]]; then
  # The caller that already put the contract in the prompt turns this read off.
  [[ "${LANE_MEMORY_SESSION:-on}" != off ]] || quiet
  reply="$(bash "$data" session 2>"$err")" \
    || { emit_fatal "$event" "lane memory: baseline failed: $(cat "$err")"; exit 0; }
  fields="$(block_fields session)"
  [[ "$("$jq_bin" '.items | length' <<<"$reply")" != 0 ]] \
    || { emit_fatal "$event" "lane memory: baseline failed: the contract read returned no items"; exit 0; }
  # A heading is not a contract: each item must carry its body or a requested field.
  empty="$("$jq_bin" -r --argjson fields "$fields" '
    [.items[] | . as $item
     | select(([$item.body] + [$fields[] | select(IN("title", "address", "kind", "revision") | not) | $item[.]])
              | map(select(. != null and . != "" and . != [] and . != {})) | length == 0)
     | .address // .title // "?"] | join(", ")' <<<"$reply")"
  [[ -z "$empty" ]] \
    || { emit_fatal "$event" "lane memory: baseline failed: items without contract text: $empty"; exit 0; }
  baseline="$(render "$fields" <<<"$reply")"

  # The filters select records; they do not appear in what those records say. The
  # launcher writes the launch facts once and they are rendered here.
  assignment="$("$jq_bin" -r '(.assignment // {}) | to_entries | map("- \(.key): \(.value | tostring)") | join("\n")' \
                 "$LANE_MEMORY_CONFIG")"
  [[ -z "$assignment" ]] || baseline="$baseline"$'\n\n## ASSIGNMENT\n'"$assignment"
  emit "$event" "$baseline"
  exit 0
fi

# ── the retrieval events ───────────────────────────────────────────────────
# No query block disables retrieval; the contract stays.
[[ -r "${LANE_MEMORY_CONFIG:-}" ]] || quiet
"$jq_bin" -e '.query | type == "object"' "$LANE_MEMORY_CONFIG" >/dev/null 2>&1 || quiet

# Normalize single-tool events to the batch shape. Preserve the tool ID for deduplication.
if [[ "$event" == PostToolUse ]]; then
  input="$("$jq_bin" -c 'if has("tool_calls") then . else
      . + {tool_calls: [ {tool_use_id: (.tool_use_id // .tool_call_id // .id // null), tool_name: (.tool_name // ""),
                          tool_input: (.tool_input // {}),
                          tool_response: (.tool_response // "")} ]} end' \
    <<<"$input" 2>/dev/null || printf '%s' "$input")"
fi

if [[ "$event" == PostToolUse || "$event" == PostToolBatch ]]; then
  input="$(python3 -c '
import fcntl, hashlib, json, os, sys
data = json.load(sys.stdin)
# Every node shares the run and the config; the caller filters tell the nodes apart.
scope = [os.environ.get(k, "") for k in ("MEDULLA_RUN_DIR", "LANE_MEMORY_CONFIG", "LANE_MEMORY_ROLE",
                                         "LANE_MEMORY_PROCESS", "LANE_MEMORY_TICKET")]
scope.append(data.get("session_id") or data.get("transcript_path") or "")
key = hashlib.sha256(json.dumps(scope).encode()).hexdigest()
file = os.path.join(os.environ.get("TMPDIR", "/tmp"), "lane-memory-seen." + key)
with open(file, "a+", encoding="utf-8") as cache:
    fcntl.flock(cache, fcntl.LOCK_EX)
    cache.seek(0)
    try: seen = json.load(cache)
    except (ValueError, OSError): seen = []
    fresh = []
    for tool in data.get("tool_calls", []):
        identity = tool.get("tool_use_id") or tool.get("tool_call_id") or tool.get("id")
        payload = [tool.get("tool_name", ""), tool.get("tool_input", {}), tool.get("tool_response", "")]
        item = "id:" + str(identity) if identity else "content:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        if item not in seen:
            fresh.append(tool)
            seen.append(item)
    cache.seek(0)
    cache.truncate()
    json.dump(seen[-256:], cache)
data["tool_calls"] = fresh
print(json.dumps(data))
' <<<"$input")" || { emit "$event" "" "lane memory: cannot deduplicate tool events"; exit 0; }
  [[ "$("$jq_bin" '.tool_calls | length' <<<"$input")" != 0 ]] || quiet
fi

if [[ "$event" == UserPromptSubmit ]]; then
  query="$("$jq_bin" -r '.prompt // empty' <<<"$input")"
else
  # PostToolUse carries no .prompt. The query is what JUST happened, and only
  # the calls that say something about the WORK.
  #
  # Measured on implement_code of run e9ea21af, 54 calls: Bash 38, ToolSearch 9,
  # Read 5, Monitor 1, ListAgents 1. Eleven say nothing about the ticket -
  # ToolSearch answers "No matching deferred tools found" every time - and those
  # are the ones dropped, by TOOL rather than by size.
  #
  # A short answer is NOT dropped. "1.4.2" beside "Verify bun is now discoverable
  # on PATH" is a real question about the environment; judging it by the length
  # of the response alone throws away the description that gives it meaning.
  #
  # Deliberately NOT the original task: it is identical on every batch, so it
  # drags every query toward the same records. Deliberately not the tool names
  # either - "Bash" and "Read" are noise in a search.
  #
  # HEAD for a file, TAIL for a command. A file opens with the doc comment that
  # names its subject; a command ENDS with the verdict - "error: script test
  # exited with code 1" - while its head is the runner's boilerplate.
  did="$("$jq_bin" -r '
      [ .tool_calls[]?
        | . as $c
        | (.tool_name // "") as $n
        | if ($n | test("^(Read|Edit|Write|NotebookEdit)$")) then (.tool_input.file_path // empty)
          elif ($n | test("^(Grep|Glob)$"))                 then (.tool_input.pattern // .tool_input.query // empty)
          elif $n == "Bash"                                  then (.tool_input.description // empty)
          # MCP несёт САМОЕ содержательное - сам запрос. Раньше он попадал в
          # else empty, то есть поиск по графу и по коду не говорил памяти
          # ничего, хотя именно он и описывает, что ищут.
          elif ($n | startswith("mcp__"))                     then
               (.tool_input.query // .tool_input.pattern // .tool_input.name
                // .tool_input.symbol // .tool_input.path // empty)
          else empty end
      ] | map(select(type=="string" and length>0)) | unique | join(". ")' <<<"$input" 2>/dev/null)"

  # THE BUDGET COVERS BOTH HALVES. A query is capped at 2000 characters and the
  # cut keeps the HEAD and drops the TAIL. Without a shared budget the
  # descriptions, which go in front, survived while every response tail behind
  # them was silently thrown away - exactly the tails this hook takes on purpose.
  #
  # A description is one line and it is the signal, so it keeps the larger half
  # and is trimmed only when it alone would fill the query: measured on
  # implement_code of run e9ea21af, 54 calls at roughly 40 characters each came
  # to 3130 - the descriptions ALONE were already over the cap, so nothing else
  # was reaching the search at all.
  did="${did:0:900}"
  got_cap=$(( 2000 - ${#did} - 1 ))
  [ "$got_cap" -gt 0 ] || got_cap=1

  # ONLY THE LAST TEN CALLS, and dropping the rest is deliberate. 54 calls
  # sharing what is left of 2000 is eighteen characters each - fragments too
  # short to retrieve anything, so an equal split spends the whole budget on
  # noise. The query asks what just happened; the tail of the batch is what
  # just happened.
  got="$("$jq_bin" -r --argjson cap "$got_cap" '
      [ .tool_calls[]?
        | (.tool_name // "") as $n
        | select($n | test("^(Read|Edit|Write|NotebookEdit|Grep|Glob|Bash)$"))
        | { n: $n,
            r: (.tool_response
                | if type=="string" then .
                  elif type=="object" then (.content // .output // .stdout // "" | tostring)
                  else tostring end) } ]
      | .[-10:]
      | (if length == 0 then 1 else length end) as $k
      | (($cap / $k) | floor) as $share
      | map(if (.n | test("^(Read|Edit|Write|NotebookEdit)$")) then .r[0:$share] else .r[-$share:] end)
      | join(" ") | gsub("\\s+"; " ")' <<<"$input" 2>/dev/null)"

  query="$(printf '%s %s' "$did" "$got")"
fi

# Whitespace only. The API limit is 2000 Unicode characters and joppa-data.sh cuts
# there; a cut in this shell could split a character in the C locale of the image.
query="$(printf '%s' "$query" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g')"
[[ -n "${query// /}" ]] || quiet

# A refused retrieval does not stop the session, but it is not silent either: an agent
# working without the memory it believes it has is the failure this lane prevents.
# An empty result is normal and adds nothing.
reply="$(bash "$data" query "$query" 2>"$err")" \
  || { emit "$event" "" "lane memory: retrieval failed: $(cat "$err")"; exit 0; }
emit "$event" "$(render "$(block_fields query)" <<<"$reply")"
