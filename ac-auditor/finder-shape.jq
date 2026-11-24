# Problems of one finder result. An empty list means the result is valid.
def text: type == "string" and length > 0;
[ (if type != "object" or (.findings | type) != "array" then "Return one JSON object with a findings list." else empty end),
  (.findings[]? | select((.criterion | IN("G", "A", "U", "M", "V", "R") | not) or (.ac_quote | text | not)
    or (.source_quote | text | not) or (.fix | text | not)) | "Each finding needs criterion, ac_quote, source_quote and fix.")
] | unique
