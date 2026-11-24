# Business findings that a critic supports with exact captured text. publication.jq blocks an AC or Test check with them,
# and rejected.jq counts AC returns with them.
def finding_text: type == "string" and test("\\S");
def node_text: (.document.data // .data // {}) | ((.title // "") + "\n" + (.body // ""));
# An AC run captures its AC, Sources and Tests directly. A Task repair captures them as the related parent context.
def finding_ac($in): $in.context.parent // $in.selected;
def finding_sources($in): if $in.context.parent then $in.context.references.sources // [] else $in.references.sources // [] end;
def finding_tests($in): ($in.children // []) + ($in.context.children // []);
# An AC defect: a configured criterion, the exact AC quote and the exact quote of a current linked Source.
def ac_findings($in; $criteria):
  [(.ac_findings // [])[]? |
    select(type == "object" and .reason_code != "GAP" and .reason_code != "CONFLICT" and (.criterion | finding_text) and
      (.criterion as $letter | ($criteria | [splits("[\\s,]+") | select(length > 0)] | index($letter)) != null) and
      (.ac_quote | finding_text) and (.source_quote | finding_text) and (.source | finding_text)) |
    . as $finding | select((finding_ac($in) | node_text | contains($finding.ac_quote)) and
      any(finding_sources($in)[]; .address == $finding.source and
        .historical != true and .document.present != false and (node_text | contains($finding.source_quote))))];
# A Test defect: the address of a current captured Test, its exact text and a reason code.
def test_findings($in):
  [((.node_findings // []) + (.findings // []))[]? |
    select(type == "object" and (.target | finding_text) and (.quote | finding_text) and (.reason_code | finding_text) and
      .reason_code != "GAP" and .reason_code != "CONFLICT") |
    . as $finding | select(any(finding_tests($in)[]; .address == $finding.target and
      $in.schema.types[.kind].role == "test" and .historical != true and .document.present != false and
      (node_text | contains($finding.quote))))];
