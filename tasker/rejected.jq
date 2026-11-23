# Route a reviewed AC or Task refusal to people. The shared publisher releases the execution claim.
$input[0] as $in | ($reason | .[0:1000]) as $why |
if $dry == "true" then
  {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN",
    reason: ("Dry run, nothing published. Would be REJECTED: " + $why | .[0:1000])}}
else
  {operations: [
    {command: {op: "save_object", kind: $in.selected.kind, id: ($in.selected.address | sub("^[^:]*:"; "")),
      revision: $in.claim_revision, data: ({stage: (if $in.schema.types[$in.selected.kind].role == "task" then "to_review" else "to_decide" end)} + ($ARGS.named.repository // {})), reason: $why}},
    {command: {op: "note", target: $in.selected.address,
      id: ("tasker-rejected-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:])), text: $why}}],
    outcome: {status: "blocked", reason_code: "REJECTED", reason: $why}}
end
