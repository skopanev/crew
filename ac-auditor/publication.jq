include "history";
# The review verdict of one 11111+R audit. Approved: the audit note, and the AC stage when stage writes are on.
# Else: the critique. Owner, 21 Nov 2026 (process:sample0004 r3): no tags. A failed AC goes to to_decide, a passed AC
# to to_prepare. With STAGE_WRITES=false only the note is published.
$draft[0] as $d | $input[0] as $in | $in.selected.address as $ac |
($ARGS.named.stages // "false") as $stages |
{codex: $codex[0], second: $second[0]} as $reviews |
["G", "A", "U", "M", "V", "R"] as $items |
def text: type == "string" and length > 0;
def valid: type == "object" and .draft_digest == $digest and (.verdict == "APPROVE" or .verdict == "REWORK") and
  (.scores | type == "object" and all($items[] as $i | .[$i]; type == "object" and (.agree | type == "boolean") and (.evidence | text))) and
  (.findings | type == "array" and all(.[]; type == "object" and (.problem | text) and (.advice | text))) and
  (.verdict == "APPROVE" or (.findings | length > 0));
def clean: valid and .verdict == "APPROVE" and all(.scores[]; .agree);
if all($reviews[]; clean) then
  (all($items[]; $d.scores[.].score == 1)) as $passed |
  # The Writer checks Tests after the AC audit.
  (if $passed then "to_prepare" else "to_decide" end) as $stage |
  ($items | map(. + "=" + ($d.scores[.].score | tostring)) | join(" ")) as $line |
  ("11111r-audit-" + $date) as $title |
  ($line + " -> " + (if $passed then "pass" else "fail" end) + ", stage " + $stage +
    (if $stages == "true" then "" else " (not written: STAGE_WRITES is false)" end)) as $result_line |
  {operations: [
    (if $stages == "true" then
      {command: {op: "save_object", kind: $in.selected.kind, id: ($ac | sub("^[^:]*:"; "")), revision: $in.claim_revision,
        data: ({stage: $stage} + manual_review($in; ($ARGS.named.fail_limit // "3"); ($ARGS.named.fail_tag // "manual-check"); ($passed | not))), reason: ("11111+R audit " + $date + ": " + $line)}} else empty end),
    {command: {op: "note", target: $ac, id: ($title + "-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-8:])),
      text: (($title + "\n" + $result_line + "\n" + ($d.summary | .[0:500]) + "\n" +
        ($items | map(. as $i | $d.scores[$i] | "- " + $i + "=" + (.score | tostring) + ": " + (.evidence | .[0:400]) +
          (if .score == 0 then "\n  Fix: " + (.fix | .[0:300]) else "" end)) | join("\n")) +
        "\nAC revision audited: " + ($in.selected.current_revision | tostring) + ". Run: " + ($run | .[-100:])) | .[0:3900])}}],
   outcome: {status: "published", reason_code: (if $passed then "PASS" else "FAIL" end), reason: $result_line}} as $result |
  {approved: true, publication: (if $dry == "true" then
    {operations: [], outcome: {status: "blocked", reason_code: "DRY_RUN",
      reason: ("Dry run, nothing published. Would be " + $result.outcome.reason | .[0:1000])}}
    else $result end), would_publish: $result}
else {approved: false, critique: ($reviews | map_values(if valid then
  {verdict, disputed: [.scores | to_entries[] | select(.value.agree | not) | {item: .key, evidence: .value.evidence}], findings, summary} else
  {invalid: "The review does not match the critic output contract or reviewed another audit."} end))} end
