# The review verdict of one tasker draft. Approved: the native operations to publish. Else: the critique for the author.
# Crew Sources ogbu6poe, w5cbnd87 and u1m9xabz: reset returns on success and preserve question stages.
# DONE uses the configured implementation stage and records the existing develop evidence.
$draft[0] as $d | $input[0] as $in | $in.selected.address as $ac |
([$in.schema.types | to_entries[] | select(.value.role == "task") | .key] | if length == 1 then .[0] else error("The schema needs one Task role") end) as $task_kind |
{codex: $codex[0], second: $second[0]} as $reviews |
["gate", "size", "reporter_names", "outside_files", "already_in_develop", "ac_test_consistency", "ac_scope"] as $questions |
def text: type == "string" and length > 0;
def valid: type == "object" and .draft_digest == $digest and (.verdict == "APPROVE" or .verdict == "REWORK") and
  (.checks | type == "object" and all($questions[] as $q | .[$q]; type == "object" and (.ok | type == "boolean") and (.evidence | text))) and
  (.findings | type == "array" and all(.[]; type == "object" and (.problem | text) and (.advice | text))) and
  (.verdict == "APPROVE" or (.findings | length > 0));
def gap_question: type == "object" and (.owner == "cto" or .owner == "ceo") and
  all([.question, .a, .b][]; type == "string" and test("\\S")) and
  (.recommended == "A" or .recommended == "B");
def clean: valid and .verdict == "APPROVE" and all(.checks[]; .ok) and
  (if $in.schema.types[$in.selected.kind].role == "task" and $d.verdict == "STALE" and $d.retirement_proof != null then
    .checks.already_in_develop.task_deliverables_complete == true else true end);
def checked_stage($kind; $value):
  if ($value | text) and (($in.schema.types[$kind].fields.stage.values // []) | index($value)) != null
  then $value else error("The configured stage is absent from the schema of " + $kind) end;
def stage($value): {command: {op: "save_object", kind: $in.selected.kind, id: ($ac | sub("^[^:]*:"; "")),
  revision: $in.claim_revision, data: {stage: checked_stage($in.selected.kind; $value), returns: 0}, reason: ("tasker: the AC goes to " + $value + ".")}};
def note_id($kind): "tasker-" + $kind + "-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-80:]);
def ordered_tasks($tasks):
  if ($tasks | length) == 0 then []
  else ($tasks | map(.id)) as $pending |
    [$tasks[] | select(all((.depends_on // [])[]; . as $dependency | ($pending | index($dependency)) == null))] as $ready |
    if ($ready | length) == 0 then error("Task dependencies contain a cycle")
    else $ready + ordered_tasks([$tasks[] | select(.id as $id | ($ready | map(.id) | index($id)) == null)]) end
  end;
def publication_tasks($tasks):
  ($tasks | map(.id)) as $ids |
  if any($tasks[]; any((.depends_on // [])[]; . as $dependency |
    ((startswith($task_kind + ":") and (ltrimstr($task_kind + ":") | test("^[A-Za-z0-9_-]+$"))) | not) and ($ids | index($dependency)) == null))
  then error("Task dependency does not name an existing address or draft id") else ordered_tasks($tasks) end;
(if $d.verdict == "SPLIT" then "OK" else $d.verdict end) as $verdict |
if ($verdict == "GAP" or $verdict == "CONFLICT") and ($d.gap | gap_question | not) then
  {approved: false, critique: {host: {invalid: "GAP or CONFLICT requires a verified owner, question, A/B options and recommendation.", gap: $d.gap}}}
elif all($reviews[]; clean) then
  (if $in.schema.types[$in.selected.kind].role == "task" then
    {operations: [], outcome: {status: "published", reason_code: "REVIEWED", reason: $d.reason}}
  elif $verdict == "OK" then
    {operations: [stage($ARGS.named.implement_stage), (publication_tasks($d.tasks)[] | {ref: ("task-" + .id), command: ({op: "save_object", kind: $task_kind, revision: 0, parent: $ac,
      reason: "Publish a Task that both independent critics approved.",
      data: {title, body, repository, stage: checked_stage($task_kind; $stage),
        owner: (($in.selected.document.data.owner // $in.selected.data.owner) | if text then . else error("Parent AC owner is missing") end)}} +
      if (.depends_on // []) | length > 0 then {relations: {depends_on: {edges: [.depends_on[] |
        {to: (if startswith($task_kind + ":") then . else {"$ref": ("task-" + . + "/address")} end)}]}}} else {} end)})],
     outcome: {status: "published", reason_code: "READY",
       reason: ("Published " + ($d.tasks | length | tostring) + " Task(s) in " + $stage + ": " + ([$d.tasks[].title] | join("; ")) | .[0:1000])}}
  elif $verdict == "DONE" then
    ("Develop already has this behavior at " + $d.done_commit + ". Tests: " +
      ([$in.children[] | select($in.schema.types[.kind].role == "test") | .address] | join(", ")) + ". " + $d.reason) as $evidence |
    {operations: [(stage($ARGS.named.done_stage) | .command.reason = ($evidence | .[0:1000])),
      {command: {op: "note", target: $ac, id: note_id("done"), text: $evidence}}],
     outcome: {status: "published", reason_code: "AC_DONE", reason: ($d.done_commit + ": " + $d.reason | .[0:1000])}}
  else
    $d.gap as $gap |
    {operations: [{command: {op: "save_object", kind: $in.selected.kind,
        id: ($ac | sub("^[^:]*:"; "")), revision: $in.claim_revision,
        data: {tags: (($in.selected.document.data.tags // []) + [($ARGS.named.gap_tags[$gap.owner] | if text then . else error("Configure the owner gap tag") end)] | unique)},
        reason: "Keep the AC stage and ask the owner to resolve the Source gap."}},
      {command: {op: "note", target: $ac, id: note_id("gap"),
        text: ("OPEN QUESTION\nOwner: " + $gap.owner + "\nQuestion: " + $gap.question +
          "\n" + (if $gap.recommended == "A" then "★ " else "" end) + "A: " + $gap.a +
          "\n" + (if $gap.recommended == "B" then "★ " else "" end) + "B: " + $gap.b +
          "\nRecommended: " + $gap.recommended + "\nReason: " + $d.reason)}}],
     outcome: {status: "blocked", reason_code: "DECISION_REQUIRED", reason: ($d.gap | tojson | .[0:1000])}}

  end) as $result |
  {approved: true, publication: (if $dry == "true" then
    {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN",
      reason: ("Dry run, nothing published. Would be " + $result.outcome.reason_code + ": " + $result.outcome.reason | .[0:1000])}}
    else $result end), would_publish: $result}
else {approved: false, critique: ($reviews | map_values(if valid then
  {verdict, failing: [.checks | to_entries[] | select(.value.ok | not) | {check: .key, evidence: .value.evidence}], findings, ac_findings: (.ac_findings // []), node_findings: (.node_findings // []), summary} else
  {invalid: "The review does not match the critic output contract or reviewed another draft.", review: .} end))} end
