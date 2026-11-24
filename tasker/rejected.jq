# Only supported business findings return an AC. Claim failures and Task repairs do not change AC returns.
include "findings" {search: "./"};
$input[0] as $in | $in.selected as $selected | ($selected.document.data // $selected.data // {}) as $data |
($in.schema.types[$selected.kind].role // "") as $role |
($ARGS.named.review[0].critique // {}) as $reviews |
def text: type == "string" and test("\\S");
def stage_for($kind; $value):
  if ($value | text) and (($in.schema.types[$kind].fields.stage.values // []) | index($value)) != null
  then $value else error("The configured return stage is absent from the selected schema") end;
def checked_stage($value): stage_for($selected.kind; $value);
[$reviews[] | select(.verdict == "REWORK") | ac_findings($in; $ARGS.named.finding_criteria)[]] as $ac_findings |
[$reviews[] | select(.verdict == "REWORK") | test_findings($in)[]] as $test_findings |
((($ac_findings | length) > 0 or ($test_findings | length) > 0)) as $supported |
($role == "ac" and $supported) as $business |
($role == "task" and $supported) as $parent_return |
($in.context.parent // {}) as $parent |
(if $parent_return then
  ($parent.document.data // {}) as $parent_data |
  ($ARGS.named.return_limit | if type == "number" and . > 0 and . == floor then . else error("TASKER_RETURN_LIMIT must be positive") end) as $limit |
  (($parent_data.returns // 0) | if type == "number" and . >= 0 and . == floor then . + 1 else error("Parent AC returns must be a nonnegative integer") end) as $count |
  {stage: (if ($ac_findings | length) > 0 then $ARGS.named.return_stage else $ARGS.named.test_return_stage end | stage_for($parent.kind; .)), returns: $count} +
  (if $count >= $limit then
    ($ARGS.named.stuck_tag | if text and . == (ltrimstr(" ") | rtrimstr(" ")) then . else error("STUCK_TAG is required") end) as $tag |
    ($parent_data.tags // [] | if type == "array" and all(.[]; type == "string") then . else error("Parent tags must be strings") end) as $tags |
    {tags: (if ($tags | index($tag)) != null then $tags else $tags + [$tag] end)}
  else {} end)
 else null end) as $parent_update |
($role == "task" and ($supported | not) and ($ARGS.named.generic_count // 1) >= ($ARGS.named.return_limit // 3)) as $task_stuck |
(if $business then
  ($ARGS.named.return_limit | if type == "number" and . > 0 and . == floor then . else error("TASKER_RETURN_LIMIT must be positive") end) as $limit |
  ((($data.returns // 0) | if type == "number" and . >= 0 and . == floor then . else error("AC returns must be a nonnegative integer") end) + 1) as $count |
  {returns: $count, stage: (if ($ac_findings | length) > 0 then $ARGS.named.return_stage else $ARGS.named.test_return_stage end | checked_stage(.))} +
    if $count >= $limit then {tags: (($data.tags // []) + [$ARGS.named.stuck_tag | if text then . else error("STUCK_TAG is required") end] | unique)} else {} end
 elif $role == "task" then {stage: ($ARGS.named.task_review_stage | checked_stage(.))} + ($ARGS.named.repository // {}) +
   (if $task_stuck then {tags: (($data.tags // []) + [$ARGS.named.stuck_tag | if text then . else error("STUCK_TAG is required") end] | unique)} else {} end)
 else {} end) as $update |
(($business or $task_stuck) and ($update.tags // [] | index($ARGS.named.stuck_tag)) != null) as $stuck |
($reason + if $task_stuck then
  "\nThe Task reached the configured limit of consecutive generic rejections: " + ($ARGS.named.generic_count | tostring) + ". Review these findings and clear the configured stuck tag after correction."
 elif $stuck then
  "\nOwner: CTO\nQuestion: The AC reached the configured return limit. Which action will resolve these findings?\nA: Resolve each finding, record the answer as a Source, clear " + $ARGS.named.stuck_tag + " and reset returns.\nB: Cancel the AC and archive it.\nRecommended: A."
  else "" end) as $note |
if $dry == "true" then
  {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN",
    reason: ("Dry run, nothing published. Would be REJECTED: " + $note | .[0:1000])}}
else
  {operations: [(if $parent_return then
    {command: {op: "save_object", kind: $parent.kind, id: ($parent.address | sub("^[^:]*:"; "")),
      revision: $parent.current_revision,
      data: $parent_update,
      reason: ($note | .[0:1000])}} else empty end),
    (if ($update | length) > 0 then
    {command: {op: "save_object", kind: $selected.kind, id: ($selected.address | sub("^[^:]*:"; "")),
      revision: $in.claim_revision, data: $update, reason: ($note | .[0:1000])}} else empty end),
    {command: {op: "note", target: $selected.address,
      id: ("tasker-rejected-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:])), text: $note}}],
    outcome: {status: "blocked", reason_code: (if $stuck then "STUCK" elif $parent_return then "TASK_PARENT_RETURN" else "REJECTED" end), reason: ($note | .[0:1000])}}
end
