$input[0] as $in | ($in.schema.types[$test] // {}) as $type | ($in.schema.test_results // {}) as $rules |
# required_fields is an object keyed by field or a list of field names.
($type.fields // {}) as $fields |
($type.required_fields // [] | if type == "object" then keys elif type == "array" then . else [] end) as $required |
([$in.children[]? | select(.kind == $test)]) as $existing |
def fits($limit): $limit == null or length <= $limit;
def name_ok: type == "string" and length > 0 and (explode | all(. >= 32)) and
  fits($type.title_max_length) and fits($rules.name.max_length) and
  ($rules.name.separator == null or $rules.name.min_parts == null or
    (split($rules.name.separator) | length >= $rules.name.min_parts));
def field_ok: .key as $key | .value as $value | ($fields[$key] // null) as $field |
  ($key != "title" and $key != "assignee") and $value != null and
  ($mode != "update" or ($key == "body" or $key == "command" or $key == "case")) and
  ($field == null or (($field.from // "own") == "own" and
    ($field.values == null or ($field.values | any(. == $value))))) and
  (($value | type) != "string" or ($value | fits($type.field_max_length)));
def target($id): [$existing[] | select(.address == ($test + ":" + $id))][0];
def complete: . as $item |
  ((if $mode == "update" then target(.id).document.data else {} end) + .data) as $data |
  all($required[]; . as $key | $key == "title" or $data[$key] != null or
    ($mode == "create" and $key == "owner" and $in.selected.document.data.owner != null));
($mode == "create" or $mode == "update") and
(.tests | type == "array" and length > 0 and length <= 98) and
($rules.max_tests == null or ($existing | length) + (if $mode == "create" then (.tests | length) else 0 end) <= $rules.max_tests) and
all(.tests[]; type == "object" and (.id | type == "string" and test("^[A-Za-z0-9_-]+$")) and
  (. as $item | .title | name_ok) and
  (. as $item | all($existing[]; .document.data.title != $item.title or
    ($mode == "update" and .address == ($test + ":" + $item.id)))) and
  ($mode != "update" or (target(.id) as $target | $target != null and
    ((.data | has("case") | not) or .data.case == $target.document.data.case))) and
  (.data | type == "object") and all(.data | to_entries[]; field_ok) and complete) and
([.tests[].id] | length == (unique | length)) and ([.tests[].title] | length == (unique | length)) and
(.coverage | type == "string" and length > 0)
