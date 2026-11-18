$draft[0] as $d | $input[0] as $in | ($d.tests | map(.id) | sort) as $ids |
{codex: $codex[0], claude: $claude[0]} as $reviews |
def valid: type == "object" and .draft_digest == $digest and (.tests | type == "array") and
  ((.tests | map(.id) | sort) == $ids) and all(.tests[]; .score | type == "string" and test("^[01]{5}$")) and
  (.coverage == "complete" or .coverage == "incomplete");
def clean: valid and all(.tests[]; .score == "11111") and .coverage == "complete" and
  (.missing | type == "array" and length == 0);
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
    data: (.data + $owner + {title})}} end | select(.command.data | length > 0)] +
  (if $mode == "update" then [] else [$in.children[] | select(.kind == $task and .document.data.stage == $waiting and .document.data.delivery == null and
  ((.document.data.assignee // "") == "") and ((.document.data.hold // "") == "")) |
    {command: {op: "save_object", kind, id: (.address | sub("^[^:]*:"; "")), revision: .current_revision,
      data: {stage: $ready}, reason: "The Tests of this item are published. The Task can start."}}] +
  [{command: {op: "save_object", kind: $in.selected.kind,
    id: ($in.selected.address | sub("^[^:]*:"; "")), revision: $in.claim_revision,
    data: {stage: $ready}, reason: "Publish the reviewed Tests and prepare this item for implementation."}}] end))}
else {approved: false, critique: ($reviews | map_values(if valid then
  {failing: [.tests[] | select(.score != "11111")], coverage, missing, summary} else
  {invalid: "The review does not match the critic output contract or reviewed another draft."} end))} end
