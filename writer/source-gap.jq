if type == "object" and (.tests | type == "array" and length == 0) and
  (.coverage | type == "string" and test("^GAP[.]\\s*\\S")) then
  $input[0] as $in |
  {operations: [
    {command: {op: "save_object", kind: $in.selected.kind,
      id: ($in.selected.address | sub("^[^:]*:"; "")), revision: $in.claim_revision,
      data: {stage: $decision}, reason: "Return the item to its owner for missing source evidence."}},
    {command: {op: "note", target: $in.selected.address,
      id: ("writer-source-gap-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:])),
      text: (.coverage[0:750] + "\nRun: " + ($run | .[-100:]) + "\nFull findings: artifacts/draft.json")}}
  ], outcome: {status: "blocked", reason_code: "SOURCE_GAP", reason: .coverage[0:1000]}}
else false end
