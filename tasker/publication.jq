# The review verdict of one tasker draft. Approved: the native operations to publish. Else: the critique for the author.
# Owner, 21 Nov 2026 (process:sample0004 r4): OK moves the AC to to_implement, GAP moves it to to_decide with a note.
# DONE moves the AC to to_implement and records the existing develop evidence.
$draft[0] as $d | $input[0] as $in | $in.selected.address as $ac |
{codex: $codex[0], second: $second[0]} as $reviews |
["gate", "size", "reporter_names", "outside_files", "already_in_develop", "ac_test_consistency", "ac_scope"] as $questions |
def text: type == "string" and length > 0;
def valid: type == "object" and .draft_digest == $digest and (.verdict == "APPROVE" or .verdict == "REWORK") and
  (.checks | type == "object" and all($questions[] as $q | .[$q]; type == "object" and (.ok | type == "boolean") and (.evidence | text))) and
  (.findings | type == "array" and all(.[]; type == "object" and (.problem | text) and (.advice | text))) and
  (.verdict == "APPROVE" or (.findings | length > 0));
def clean: valid and .verdict == "APPROVE" and all(.checks[]; .ok) and
  (if $in.schema.types[$in.selected.kind].role == "task" and $d.verdict == "STALE" and $d.retirement_proof != null then
    .checks.already_in_develop.task_deliverables_complete == true else true end);
def stage($value): {command: {op: "save_object", kind: $in.selected.kind, id: ($ac | sub("^[^:]*:"; "")),
  revision: $in.claim_revision, data: {stage: $value}, reason: ("tasker: the AC goes to " + $value + ".")}};
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
    (test("^task:[A-Za-z0-9_-]+$") | not) and ($ids | index($dependency)) == null))
  then error("Task dependency does not name an existing address or draft id") else ordered_tasks($tasks) end;
(if $d.verdict == "SPLIT" then "OK" else $d.verdict end) as $verdict |
if all($reviews[]; clean) then
  (if $in.schema.types[$in.selected.kind].role == "task" then
    {operations: [], outcome: {status: "published", reason_code: "REVIEWED", reason: $d.reason}}
  elif $verdict == "OK" then
    {operations: [stage("to_implement"), (publication_tasks($d.tasks)[] | {ref: ("task-" + .id), command: ({op: "save_object", kind: "task", revision: 0, parent: $ac,
      reason: "Publish a Task that both independent critics approved.",
      data: {title, body, repository, stage: $stage,
        owner: (($in.selected.document.data.owner // $in.selected.data.owner) | if text then . else error("Parent AC owner is missing") end)}} +
      if (.depends_on // []) | length > 0 then {relations: {depends_on: {edges: [.depends_on[] |
        {to: (if test("^task:") then . else {"$ref": ("task-" + . + "/address")} end)}]}}} else {} end)})],
     outcome: {status: "published", reason_code: "READY",
       reason: ("Published " + ($d.tasks | length | tostring) + " Task(s) in " + $stage + ": " + ([$d.tasks[].title] | join("; ")) | .[0:1000])}}
  elif $verdict == "DONE" then
    ("Develop already has this behavior at " + $d.done_commit + ". Tests: " +
      ([$in.children[] | select(.kind == "test") | .address] | join(", ")) + ". " + $d.reason | .[0:1000]) as $evidence |
    {operations: [(stage("to_implement") | .command.reason = $evidence),
      {command: {op: "note", target: $ac, id: note_id("done"), text: $evidence}}],
     outcome: {status: "blocked", reason_code: "ALREADY_IN_DEVELOP", reason: ($d.done_commit + ": " + $d.reason | .[0:1000])}}
  else
    {operations: [stage("to_decide"), {command: {op: "note", target: $ac, id: note_id("gap"), text: ("Decision required. " + $d.gap | .[0:1000])}}],
     outcome: {status: "blocked", reason_code: "DECISION_REQUIRED", reason: ($d.gap | .[0:1000])}}
  end) as $result |
  {approved: true, publication: (if $dry == "true" then
    {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN",
      reason: ("Dry run, nothing published. Would be " + $result.outcome.reason_code + ": " + $result.outcome.reason | .[0:1000])}}
    else $result end), would_publish: $result}
else {approved: false, critique: ($reviews | map_values(if valid then
  {verdict, failing: [.checks | to_entries[] | select(.value.ok | not) | {check: .key, evidence: .value.evidence}], findings, summary} else
  {invalid: "The review does not match the critic output contract or reviewed another draft."} end))} end
