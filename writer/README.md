# Writer

Writer writes reviewed acceptance Tests for one selected tracker item.
It runs as a configured flow of the existing planning-joppa dispatcher. It has no dispatcher of its own.

```sh
sh lane-launcher/planner-joppa.sh /absolute/writer-config.json
```

## Flow

1. `prepare` checks the required vars. The shared flow stage reads the selected item, its references and its direct children, and claims the item.
2. `author` drafts the new Tests. It sees the selected item, its references, its existing Tests, the author contract and the critic questions.
   Task children stay out of the agent view. Writer does not change Tasks.
   The shared prepare stage checks that the selected item matches `selection`, such as AC stage `to_prepare`.
3. `draft_check` checks the draft against the native Test schema. It records the digest of the exact draft bytes.
4. `critics` runs two independent seats from different vendors in parallel. Codex is the first seat.
   The second seat uses Claude Code by default. Set its harness to `agy` to use Gemini. Each seat scores every Test and the coverage.
5. `review_join` publishes only when both seats reviewed the same digest, every Test scores `11111` and both seats find complete coverage.
6. `publish` creates the Tests in one native transaction. It preserves the selected item's stage.
   The shared stage releases the claim in that transaction and refuses operations outside `config.publication`.

A refused draft returns to the author with the findings, up to `vars.REWORK_LIMIT` times.
Set `vars.DECISION_STAGE` to return coverage-only refusals to the item owner immediately in create mode.
Both critics must review the same draft and score every Test `11111`.
At least one critic must report incomplete coverage with a nonempty `missing` list. Other review failures keep the existing rework path.
Writer publishes no Test or Task changes in this case. It saves the selected item's stage, adds a `missing` note and releases its claim atomically.
The result has `reason_code: COVERAGE_INCOMPLETE`. The full findings stay in the existing critic artifacts.
The configured publication policy must allow `note` and updates to the selected kind.
In create mode, an empty `tests` array with `coverage: "GAP. <missing source detail>"` takes the same decision route.
Writer saves `DECISION_STAGE`, adds the source gap note and releases its claim atomically.
It records `reason_code: SOURCE_GAP` and starts no critics for this draft. The full text stays in `artifacts/draft.json`.
Use `exclude_children` with the Test kind to exclude items that already have Tests from the create queue.
An empty or omitted `DECISION_STAGE` keeps the existing rework path. Update mode keeps its existing stage behavior.
The default permits one rework. Set `2` to permit two reworks after the initial draft.
Invalid drafts and critic refusals use the same rework budget. The workflow has one deadline of 3600 seconds.
The workflow sets no node timeouts. Its native `on_timeout` handler runs `failed` once after the deadline.
The `failed` node records the reason in `failure.txt`, and the shared stage releases the claim with a note.

To revise existing Tests, set `vars.TEST_OPERATION` to `update`, `publication.create_kinds` to `[]`,
and `publication.update_kinds` to only the configured `TEST_KIND`. Include those direct children in `children`.
Remove any `exclude_children` filter that excludes the existing Tests.
The author uses their existing IDs. The same two critics review the revised text.
Publication uses each child's frozen revision and sends only changed text fields. It preserves the parent, case, owner and relations.
Earlier results remain as evidence for their earlier contract. Update mode changes no AC or Task stage.
The host releases its existing selection claim. The normal revision checks refuse concurrent changes.
The default operation remains `create`.
Use `selection` to control which item stages can receive edits. Update mode adds no stage restriction of its own.
An unchanged draft publishes no Test write and records `reason_code: NO_CHANGES`.

For the kinds in the example config, the update overrides are:

```json
{"vars":{"TEST_OPERATION":"update"},"publication":{"file":"operations.json","allowed_operations":["save_object"],"create_kinds":[],"update_kinds":["test"]}}
```

Use your configured Test kind in place of `test` when its name differs.

## Configuration

See `config.example.json`. The project supplies every native name:

| key | use |
|---|---|
| `workflow` | Absolute path to this `workflow.yaml` |
| `selection`, `order`, `exclude_children` | Native Joppa filters that select one item for each pass |
| `children` | Native filter for the direct children. Include the Test kind |
| `references` | Data fields of the selected item that name related objects |
| `publication` | `file`, `allowed_operations`, `create_kinds` and `update_kinds`. Permit selected-kind updates for the optional decision route |
| `vars.TEST_KIND` | Native kind of the Tests |
| `vars.DECISION_STAGE` | Optional selected-item stage for coverage-only refusals, such as `to_decide` |
| `vars.CRITIC_SECOND_HARNESS` | `claude-code` (default) or `agy`. A second Codex seat is refused |
| `vars.REWORK_LIMIT` | Optional nonnegative rework count. Defaults to `1` |
| `vars.AUTHOR_MODEL`, `vars.CRITIC_CODEX_MODEL`, `vars.CRITIC_SECOND_MODEL` | Optional model overrides |
| `context.roles.author`, `context.roles.critic` | Contract records of the two roles. The critic contract gives the five review questions |

A role binding can name `{role, process, kind}` when these names differ.
`role` and `process` supply their separate configured memory filters.
`kind` requires a contract node of that kind in the reply. Common rules alone cannot satisfy this check.
A string keeps the previous behavior: it supplies the same role and process name.
The configured flow checks its live role contracts before it claims an item or starts an agent.

For a Gemini second seat, set `CRITIC_SECOND_HARNESS=agy` and `CRITIC_SECOND_MODEL=gemini-4-carbon-high` in `vars`.
Rename the previous `CRITIC_CLAUDE_MODEL` key to `CRITIC_SECOND_MODEL`.
The launcher supplies `AGY_PROFILE_HOME`. Do not set it in `vars`.
Reports use the stable seat names `critic-codex.json` and `critic-second.json` for either second harness.

## Test fields

The schema entry of `TEST_KIND` supplies every rule. Writer has no own limit:

- every required field, except `title`, in the Test data. Crew copies the selected item's owner as the new Test owner.
- one listed value for each typed field, and no field that the schema computes.
- `title_max_length`, `field_max_length`, `test_results.max_tests` and the `test_results.name` rules, when the schema gives them.
- at most 98 Test writes. The host also releases the selected item's claim in the publication batch.

## Isolation

The agents get no tracker credentials and no MCP servers. The Claude seats have their file, shell and web tools disallowed.
The AGY seat uses a temporary broker profile and `BROKER_ISOLATE_MCP=1`. The existing planning preflight verifies its empty MCP inventory.
A failed isolation check stops the critic before its model call. The profile is removed when the flow exits.
The Codex seat runs in the read-only sandbox without user configuration or MCP servers.
A read-only sandbox can still read files. Start Medulla in an empty working directory to keep source out of reach.
