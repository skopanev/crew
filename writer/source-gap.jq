if type == "object" and (.tests | type == "array" and length == 0) and
  (.coverage | type == "string" and test("^GAP[.]\\s*\\S")) then
  $input[0] as $in |
  # A GAP adds the question tag and keeps the stage (scheme crew_team).
  {operations: [
    (if (($in.selected.document.data.tags // []) | index($gap_tag)) == null then
    {command: {op: "save_object", kind: $in.selected.kind,
      id: ($in.selected.address | sub("^[^:]*:"; "")), revision: $in.claim_revision,
      data: {tags: (($in.selected.document.data.tags // []) + [$gap_tag] | unique)},
      reason: "Writer needs an owner decision for missing source evidence. The AC keeps its stage."}} else empty end),
    {command: {op: "note", target: $in.selected.address,
      id: ("writer-source-gap-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:])),
      text: (.coverage + "\nRun: " + ($run | .[-100:]))}}
  ], outcome: {status: "blocked", reason_code: "SOURCE_GAP", reason: .coverage[0:1000]}}
else false end
