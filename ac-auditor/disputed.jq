include "history";
# A disputed audit after the rework limit is a failed audit (owner, 21 Nov 2026: "просто вернул с GAP").
# The AC goes to to_decide with a note: the scores of the last audit and the objections that stopped it.
# Inputs: the claimed assignment, the last draft (it can be invalid) and the stop reason.
$input[0] as $in | $in.selected.address as $ac | ($draft[0] // {}) as $d |
["G", "A", "U", "M", "V", "R"] as $items |
(if ($d.scores | type) == "object" and all($items[]; ($d.scores[.] | type) == "object" and ($d.scores[.].score == 0 or $d.scores[.].score == 1))
 then $items | map(. + "=" + ($d.scores[.].score | tostring)) | join(" ") else "no valid scores" end) as $line |
("11111r-audit-" + $date) as $title |
{operations: [
  (if $stages == "true" then
    {command: {op: "save_object", kind: $in.selected.kind, id: ($ac | sub("^[^:]*:"; "")), revision: $in.claim_revision,
      data: ({stage: "to_decide"} + manual_review($in; ($ARGS.named.fail_limit // "3"); ($ARGS.named.fail_tag // "manual-check"); true)), reason: ("11111+R audit " + $date + ": disputed, the AC goes to to_decide")}} else empty end),
  {command: {op: "note", target: $ac, id: ($title + "-" + ($run | gsub("[^A-Za-z0-9_.-]"; "_") | .[-8:])),
    text: (($title + "\n" + $line + " -> disputed, stage to_decide" +
      (if $stages == "true" then "" else " (not written: STAGE_WRITES is false)" end) + "\n" +
      "The critics did not agree with the audit after the rework limit.\nObjections: " + ($reason | .[0:1200]) + "\n" +
      (try ($items | map(. as $i | $d.scores[$i] | select(type == "object") |
        "- " + $i + "=" + (.score | tostring) + ": " + ((.evidence // "") | .[0:300]) +
        (if .score == 0 then "\n  Fix: " + ((.fix // "") | .[0:250]) else "" end)) | join("\n")) catch "") +
      "\nAC revision audited: " + ($in.selected.current_revision | tostring) + ". Run: " + ($run | .[-100:])) | .[0:3900])}}],
 outcome: {status: "published", reason_code: "DISPUTED", reason: ($line + " -> disputed, stage to_decide. " + $reason | .[0:1000])}}
