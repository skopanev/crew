#!/usr/bin/env bash
set -uo pipefail
# Read lane memory from the Joppa data API: one POST, the reply JSON on stdout.
#
#   joppa-data.sh session|stop|query [QUERY]   the validated reply {workspace, position, items}
#   joppa-data.sh render FIELDS_JSON < REPLY    the items as text, one section each
#
# LANE_MEMORY_CONFIG names the launcher's JSON: url (the exact endpoint), workspace,
# token_file, root, filter_env, and one block per mode with kind, filter, filter_env,
# fields (stop: field) and max_chars; the query block also carries limit.
# A failure prints one line on stderr and exits 1. The caller decides how loud it is.
jq_bin="${JQ_BIN:-jq}"
curl_bin="${CURL_BIN:-curl}"
mode="${1:-}"
query="${2:-}"

fail() { printf '%s\n' "$*" >&2; exit 1; }

# One item per section: its title, its body, then each requested field the reply carries,
# in reply order. Identity fields are the address of the text, not the text.
if [[ "$mode" == render ]]; then
  "$jq_bin" -r --argjson fields "${2:-[]}" '
    def show: if type == "string" then . elif type == "array" then map(tostring) | join(", ") else tojson end;
    [.items[] | . as $item
     | (["## \(.title // .address)"]
        + (if (.body // "") != "" then [.body] else [] end)
        + [$fields[] | select(IN("title", "body", "address", "kind", "revision") | not)
           | select($item[.] != null) | "\(.): \($item[.] | show)"])
     | join("\n")] | join("\n\n")' || fail "render failed"
  exit 0
fi

config="${LANE_MEMORY_CONFIG:-}"
[[ -n "$config" ]] || fail "LANE_MEMORY_CONFIG is not set"
[[ -r "$config" ]] || fail "LANE_MEMORY_CONFIG is not readable: $config"
case "$mode" in session|stop|query) ;; *) fail "unknown mode: $mode" ;; esac
[[ "$mode" != query || -n "$query" ]] || fail "query mode needs a query"

# Filter values come from the environment through configured names. Nothing is evaluated,
# and an unset name is an error: a missing filter would widen the read without a word.
# A mode's filter_env replaces the root map whole; its static filter still merges.
body="$("$jq_bin" -c --arg mode "$mode" --arg query "$query" '
  def need($key): if (.[$key] | type) == "string" and (.[$key] | length) > 0 then .[$key]
                  else error("config \($key) is missing") end;
  . as $config
  | ($config[$mode] // error("config \($mode) is missing")) as $block
  | (($block.filter_env // $config.filter_env // {})
     | to_entries
     | map(.value as $name | (env[$name] // "") as $value
           | if $value == "" then error("filter variable \($name) is unset")
             else {key, value: $value} end)
     | from_entries) as $resolved
  | {workspace: ($config | need("workspace")),
     kind: ($block.kind // error("config \($mode).kind is missing")),
     filter: (($block.filter // {}) + $resolved)}
  + if ($config.root | if type == "string" then test("\\S") else false end)
    then {root: $config.root} else {} end
  + if $mode == "stop" then {fields: [$block | need("field")]}
    elif $block.fields then {fields: $block.fields} else {} end
  + if $block.max_chars then {max_chars: $block.max_chars} else {} end
  # The API counts Unicode characters. jq slices code points, so the cut never splits one.
  + if $mode == "query" then {query: $query[:2000],
                              limit: ($block.limit // error("config query.limit is missing"))}
    else {} end
' "$config" 2>&1)" || fail "invalid config: $body"

url="$("$jq_bin" -r '.url // empty' "$config")"
token_file="$("$jq_bin" -r '.token_file // empty' "$config")"
[[ -n "$url" ]] || fail "config url is missing"
[[ -r "$token_file" ]] || fail "token_file is not readable"
token=""
IFS= read -r token < "$token_file" || true
# The key goes into curl's config on stdin. It never appears in argv or the environment,
# Only a workspace read key is accepted, whoever the caller is.
[[ "$token" =~ ^jpr_[0-9a-f]{64}$ ]] || fail "token_file does not hold one Joppa read key"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/lane-memory.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
printf '%s' "$body" > "$tmp/body"
status="$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
  | "$curl_bin" -sS -K - -X POST -H 'Content-Type: application/json' \
      --data-binary @"$tmp/body" -o "$tmp/reply" -w '%{http_code}' \
      --max-time "${LANE_MEMORY_TIMEOUT:-30}" "$url" 2>"$tmp/error")" \
  || fail "request failed: $(head -c 300 "$tmp/error")"
[[ "$status" == 2?? ]] || fail "HTTP $status: $(head -c 500 "$tmp/reply")"
"$jq_bin" -e '.items | type == "array"' "$tmp/reply" >/dev/null 2>&1 \
  || fail "reply has no items list: $(head -c 300 "$tmp/reply")"
cat "$tmp/reply"
