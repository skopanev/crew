$draft[0] as $d | $input[0] as $in | ($d.tests | map(.id) | sort) as $ids |
{codex: $codex[0], second: $second[0]} as $reviews |
def valid: type == "object" and .draft_digest == $digest and (.tests | type == "array") and
  ((.tests | map(.id) | sort) == $ids) and all(.tests[]; .score | type == "string" and test("^[01]{5}$")) and
  (.coverage == "complete" or .coverage == "incomplete");
def clean: valid and all(.tests[]; .score == "11111") and .coverage == "complete" and
  (.missing | type == "array" and length == 0);
def coverage_review: valid and
  (.missing | type == "array" and all(.[]; type == "string" and length > 0)) and
  (if .coverage == "complete" then (.missing | length == 0) else (.missing | length > 0) end);
(if $in.selected.document.data.owner
 then {owner: $in.selected.document.data.owner} else {} end) as $owner |
if all($reviews[]; clean) then {approved: true, operations: (
  [$d.tests[] | . as $item | if $mode == "update" then
    ($in.children[] | select(.kind == $test and .address == ($test + ":" + $item.id))) as $target |
    {ref: ("test-" + .id), command: {op: "save_object", kind: $test, id: .id,
      revision: $target.current_revision, reason: "Update the Test text that both independent critics approved.",
      data: ((.data + {title}) | with_entries(select(.value != $target.document.data[.key])))}}
  else {ref: ("test-" + .id), command: {op: "save_object", kind: $test, revision: 0,
    parent: $in.selected.address, reason: "Publish a Test that both independent critics approved.",
    data: (.data + $owner + {title})}} end | select(.command.data | length > 0)])}
elif $mode == "create" and $gap_tag != "" and all($reviews[]; coverage_review) and
  any($reviews[]; .coverage == "incomplete" and .coverage_gap_kind == "ac") then
  ([$reviews[].missing[]] | unique) as $missing |
  {approved: false, decision_required: true, operations: [
    (if (($in.selected.document.data.tags // []) | index($gap_tag)) == null then
     {command: {op: "save_object", kind: $in.selected.kind,
      id: ($in.selected.address | sub("^[^:]*:"; "")), revision: $in.claim_revision,
      data: {tags: (($in.selected.document.data.tags // []) + [$gap_tag] | unique)},
      reason: "Return the item to its owner for missing acceptance coverage."}} else empty end),
    {command: {op: "note", target: $in.selected.address,
      id: ("writer-missing-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:])),
      text: ("Missing coverage:\n" + ($missing | join("\n") | .[0:750]) +
        "\nRun: " + ($run | .[-100:]) + "\nFull findings: artifacts/critic-codex.json and artifacts/critic-second.json")}}
  ], outcome: {status: "blocked", reason_code: "COVERAGE_INCOMPLETE", reason: ($missing | join("; ") | .[0:1000])}}
else {approved: false, critique: ($reviews | map_values(if valid then
  {failing: [.tests[] | select(.score != "11111")], coverage, coverage_gap_kind, missing, summary} else
  {invalid: "The review does not match the critic output contract or reviewed another draft."} end))} end
