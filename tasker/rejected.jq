# Only supported business findings return an AC. Claim failures and Task repairs do not change AC returns.
$input[0] as $in | $in.selected as $selected | ($selected.document.data // $selected.data // {}) as $data |
($in.schema.types[$selected.kind].role // "") as $role |
($ARGS.named.review[0].critique // {}) as $reviews |
def text: type == "string" and test("\\S");
def checked_stage($value):
  if ($value | text) and (($in.schema.types[$selected.kind].fields.stage.values // []) | index($value)) != null
  then $value else error("The configured return stage is absent from the selected schema") end;
def body: (.document.data // .data // {}) | ((.title // "") + "\n" + (.body // ""));
[$reviews[] | select(.verdict == "REWORK") | (.ac_findings // [])[]? |
  select(.reason_code != "GAP" and .reason_code != "CONFLICT" and (.criterion | text) and (.criterion as $letter | ($ARGS.named.finding_criteria | [splits("[\\s,]+") | select(length > 0)] | index($letter)) != null) and
    (.ac_quote | text) and (.source_quote | text) and (.source | text)) |
  . as $finding | select(($selected | body | contains($finding.ac_quote)) and
    any(($in.references.sources // [])[]; .address == $finding.source and
      .historical != true and .document.present != false and (body | contains($finding.source_quote))))] as $ac_findings |
[$reviews[] | select(.verdict == "REWORK") | ((.node_findings // []) + (.findings // []))[]? |
  select((.target | text) and (.quote | text) and (.reason_code | text) and
    .reason_code != "GAP" and .reason_code != "CONFLICT") |
  . as $finding | select(any(($in.children // [])[]; .address == $finding.target and
    $in.schema.types[.kind].role == "test" and .historical != true and .document.present != false and
    (body | contains($finding.quote))))] as $test_findings |
($role == "ac" and (($ac_findings | length) > 0 or ($test_findings | length) > 0)) as $business |
(if $business then
  ($ARGS.named.return_limit | if type == "number" and . > 0 and . == floor then . else error("TASKER_RETURN_LIMIT must be positive") end) as $limit |
  ((($data.returns // 0) | if type == "number" and . >= 0 and . == floor then . else error("AC returns must be a nonnegative integer") end) + 1) as $count |
  {returns: $count, stage: (if ($ac_findings | length) > 0 then $ARGS.named.return_stage else $ARGS.named.test_return_stage end | checked_stage(.))} +
    if $count >= $limit then {tags: (($data.tags // []) + [$ARGS.named.stuck_tag | if text then . else error("STUCK_TAG is required") end] | unique)} else {} end
 elif $role == "task" then {stage: ($ARGS.named.task_review_stage | checked_stage(.))} + ($ARGS.named.repository // {})
 else {} end) as $update |
($business and ($update.tags // [] | index($ARGS.named.stuck_tag)) != null) as $stuck |
($reason + if $stuck then
  "\nOwner: CTO\nQuestion: The AC reached the configured return limit. Which action will resolve these findings?\nA: Resolve each finding, record the answer as a Source, clear " + $ARGS.named.stuck_tag + " and reset returns.\nB: Cancel the AC and archive it.\nRecommended: A."
  else "" end) as $note |
if $dry == "true" then
  {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN",
    reason: ("Dry run, nothing published. Would be REJECTED: " + $note | .[0:1000])}}
else
  {operations: [(if ($update | length) > 0 then
    {command: {op: "save_object", kind: $selected.kind, id: ($selected.address | sub("^[^:]*:"; "")),
      revision: $in.claim_revision, data: $update, reason: ($note | .[0:1000])}} else empty end),
    {command: {op: "note", target: $selected.address,
      id: ("tasker-rejected-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:])), text: $note}}],
    outcome: {status: "blocked", reason_code: (if $stuck then "STUCK" else "REJECTED" end), reason: ($note | .[0:1000])}}
end
