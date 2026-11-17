# Writer

Writer writes reviewed acceptance Tests for one selected tracker item.
It runs as a configured flow of the existing planning-joppa dispatcher. It has no dispatcher of its own.

```sh
sh lane-launcher/planner-joppa.sh /absolute/writer-config.json
```

## Flow

1. `prepare` checks the required vars. The shared flow stage reads the selected item, its references and its direct children, and claims the item.
2. `author` drafts the new Tests. It sees the selected item, its references, its existing Tests, the author contract and the critic questions.
   Task children stay out of the agent view. The host advances only unassigned Tasks without a hold or delivery.
   The shared prepare stage checks that the selected item matches `selection`, such as AC stage `to_prepare`.
3. `draft_check` checks the draft against the native Test schema. It records the digest of the exact draft bytes.
4. `critics` runs two independent seats from different vendors in parallel. Each seat scores every Test and the coverage.
5. `review_join` publishes only when both seats reviewed the same digest, every Test scores `11111` and both seats find complete coverage.
6. `publish` creates the Tests and moves the selected item to `vars.READY_STAGE` in one native transaction.
   The shared stage releases the claim in that transaction and refuses operations outside `config.publication`.

A refused draft returns to the author with the findings, up to `vars.REWORK_LIMIT` times.
The default permits one rework. Set `2` to permit two reworks after the initial draft.
Invalid drafts and critic refusals use the same budget. Every node keeps its timeout.
The finite rework count bounds the number of rounds. The author and critic nodes each allow at most 1200 seconds.
There is no global deadline that can bypass the claim release after a node timeout.
The `failed` node then records the reason in `failure.txt`, and the shared stage releases the claim with a note.

## Configuration

See `config.example.json`. The project supplies every native name:

| key | use |
|---|---|
| `workflow` | Absolute path to this `workflow.yaml` |
| `selection`, `order`, `exclude_children` | Native Joppa filters that select one item for each pass |
| `children` | Native filter for the direct children. Include the Test and Task kinds |
| `references` | Data fields of the selected item that name related objects |
| `publication` | `file`, `allowed_operations`, `create_kinds` and `update_kinds`. Permit updates to the selected kind and Task kind |
| `vars.TEST_KIND`, `vars.TASK_KIND` | Native kinds of new Tests and of the Tasks that wait for them |
| `vars.WAITING_STAGE`, `vars.READY_STAGE` | Task stages before and after publication. The selected item also moves to `READY_STAGE` |
| `vars.REWORK_LIMIT` | Optional nonnegative rework count. Defaults to `1` |
| `vars.AUTHOR_MODEL`, `vars.CRITIC_CODEX_MODEL`, `vars.CRITIC_CLAUDE_MODEL` | Optional model overrides |
| `context.roles.author`, `context.roles.critic` | Contract records of the two roles. The critic contract gives the five review questions |

A role binding can name `{role, process, kind}` when these names differ.
`role` and `process` supply their separate configured memory filters.
`kind` requires a contract node of that kind in the reply. Common rules alone cannot satisfy this check.
A string keeps the previous behavior: it supplies the same role and process name.
The configured flow checks its live role contracts before it claims an item or starts an agent.

## Test fields

The schema entry of `TEST_KIND` supplies every rule. Writer has no own limit:

- every required field, except `title`, in the Test data. Crew copies the selected item's owner as the new Test owner.
- one listed value for each typed field, and no field that the schema computes.
- `title_max_length`, `field_max_length`, `test_results.max_tests` and the `test_results.name` rules, when the schema gives them.
- at most 98 operations for new Tests and Task updates. This is the host batch limit.

## Isolation

The agents get no tracker credentials and no MCP servers. The Claude seats have their file, shell and web tools disallowed.
The Codex seat runs in the read-only sandbox without user configuration or MCP servers.
A read-only sandbox can still read files. Start Medulla in an empty working directory to keep source out of reach.
