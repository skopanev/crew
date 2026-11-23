# Count completed failed audit notes. Model reworks are not separate audits.
def audit_failures($input):
  [($input.selected.annotations.comments // {} | .[]) |
    select((.id // "") | startswith("11111r-audit-")) |
    select((.text // "" | split("\n")[1] // "") | test(" -> (fail|disputed), stage "))] | length;
def manual_review($input; $limit; $tag; $failed):
  if $failed and (audit_failures($input) + 1) >= ($limit | tonumber) then
    {tags: (($input.selected.document.data.tags // []) + [$tag] | unique)}
  else {} end;
