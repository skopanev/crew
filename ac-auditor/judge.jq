# The publication of one judge decision (scheme crew_team, Auditor).
# PASS: stage to_prepare, returns 0. FAIL: stage to_decide, returns + 1, a note with the accepted findings.
# returns reaches the limit: the tag stuck, a question to the Owner.
$judge[0] as $j | $input[0] as $in | $in.selected.address as $ac |
($in.selected.document.data // {}) as $data |
($j.verdict == "PASS") as $passed |
(if $passed then 0 else (($data.returns // 0) + 1) end) as $returns |
($returns >= ($limit | tonumber)) as $stuck |
("11111r-audit-" + $date) as $title |
($j.verdict + (if $passed then ", stage " + $pass_stage else ", stage " + $fail_stage + ", returns " + ($returns | tostring) end) +
  (if $stuck then ", stuck" else "" end)) as $line |
{operations: [
  (if $stages == "true" then
    {command: {op: "save_object", kind: $in.selected.kind, id: ($ac | sub("^[^:]*:"; "")), revision: $in.claim_revision,
      data: ({stage: (if $passed then $pass_stage else $fail_stage end), returns: $returns} +
        (if $stuck then {tags: (($data.tags // []) + [$stuck_tag] | unique)} else {} end)),
      reason: ("Audit " + $date + ": " + $line)}} else empty end),
  {command: {op: "note", target: $ac, id: ($title + "-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-8:])),
    text: (($title + "\n" + $line + "\n" + ($j.summary // "") + "\n" +
      ($j.accepted | map("- " + .criterion + ": \"" + .ac_quote + "\" breaks \"" + .source_quote +
        "\" (" + (.source // "") + ")\n  Fix: " + .fix) | join("\n")) +
      "\nAC revision audited: " + ($in.selected.current_revision | tostring) + ". Run: " + $run))}},
  (if $stuck then {command: {op: "note", target: $ac, id: ("stuck-question-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-8:])),
    text: ("OPEN QUESTION (Owner, tag " + $stuck_tag + "): the AC failed the audit " + ($returns | tostring) +
      " times in a row. The findings are in the audit notes above.\nA ★: fix the AC by the findings and audit it again.\nB: archive the AC.")}} else empty end)],
 outcome: {status: "published", reason_code: $j.verdict, reason: $line}} as $result |
{publication: (if $dry == "true" then
  {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN", reason: ("Dry run, nothing published. Would be " + $line)}}
  else $result end), would_publish: $result}
