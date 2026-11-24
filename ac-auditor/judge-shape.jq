# Problems of one judge decision. An empty list means the decision is valid.
def text: type == "string" and length > 0;
[ (if type != "object" then "Return one JSON object." else empty end),
  (if (.verdict | IN("PASS", "FAIL", "INCOMPLETE")) | not then "verdict must be PASS, FAIL or INCOMPLETE." else empty end),
  (if (.accepted | type) != "array" then "accepted must be a list." else empty end),
  (.accepted[]? | select((.criterion | IN("G", "A", "U", "M", "V", "R") | not) or (.ac_quote | text | not)
    or (.source_quote | text | not) or (.fix | text | not)) | "Each accepted finding needs criterion, ac_quote, source_quote and fix."),
  (if .verdict == "FAIL" and ((.accepted // []) | length) == 0 then "FAIL needs at least one accepted finding." else empty end),
  (if .verdict == "PASS" and ((.accepted // []) | length) > 0 then "PASS has no accepted finding." else empty end)
] | unique
