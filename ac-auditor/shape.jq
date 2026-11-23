# The problems of one audit draft against the output contract. An empty list means the critics can review it.
# The note cuts each value further, so these limits bound only the size of one item.
["G", "A", "U", "M", "V", "R"] as $items | (.scores // {}) as $scores |
[ (if type != "object" or ($scores | type) != "object" then "Return one JSON object with scores and summary." else empty end),
  ($items[] as $i | $scores[$i] as $s |
    if $s == null then "\($i): the score is missing."
    elif ($s | type) != "object" then "\($i): give an object with score, evidence and fix."
    else
      (if $s.score != 0 and $s.score != 1 then "\($i): score must be 0 or 1." else empty end),
      (if ($s.evidence | type) != "string" or ($s.evidence | length) == 0 then "\($i): evidence is required."
       elif ($s.evidence | length) > 1000 then "\($i): evidence has \($s.evidence | length) characters, at most 1000. Shorten it." else empty end),
      (if $s.score == 0 and (($s.fix | type) != "string" or ($s.fix | length) == 0) then "\($i): a 0 needs a fix."
       elif $s.score == 0 and ($s.fix | length) > 600 then "\($i): fix has \($s.fix | length) characters, at most 600. Shorten it." else empty end)
    end),
  ($scores | keys? // [] | map(select(. as $k | $items | index($k) | not)) | if length > 0 then "Unknown score keys: \(join(", ")). Use only G, A, U, M, V and R." else empty end),
  (if (.summary | type) != "string" or (.summary | length) == 0 then "summary is required." else empty end)
]
