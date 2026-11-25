# Joppa planning

An explicit `workflow` selects a configured Medulla flow through this same dispatcher.
Without this field, the bundled Requirement planner keeps its existing behavior.
For the configured path, use:

```sh
sh ./lane-launcher/planner-joppa.sh /absolute/path/to/flow.json
sh ./lane-launcher/planner-joppa.sh /absolute/path/to/flow.json --item-id ac:criterion-id --dry-run
```

Set these fields in the flow config:

- `workflow`: the absolute path to a Medulla `workflow.yaml`.
- `selection`: native Joppa filters, including `kind`. Optional `order` lists `{field, direction}` entries with optional `values`.
- `exclude_children`: an optional native filter, or a list of filters, for direct children that exclude a selected item. Each filter can exclude the item.
- An `exclude_children` filter can set `except_pending_tag`. A child with that tag and `delivery.state=pending` does not block selection. Other filters still apply. Context reads keep the child.
- `references`: selected data reference fields to read. Optional `children` supplies a native direct-child query.
- `publication`: `file`, `allowed_operations`, `create_kinds` and `update_kinds`. Pass workflow models and stages through `vars`.

`order` can read computed fields such as `status`.
Set `values: ["blue", "orange", "green"]` with `direction: "asc"` to use that sequence.
Unlisted values share a later rank. `desc` reverses these ranks. Missing values stay last.

The dispatcher adds no stage, Task, Requirement or dependency selection rule to this path.
The configured filter decides eligibility. The existing claim prevents two flows from editing the same selected object.
The host loads the configured live role contracts from `context.roles`.
It does not require repositories or CBM for a flow that does not use them.
The workflow controls its stages, model calls, review decisions and revision loop.
Writer is the first bundled example in [writer](../writer/README.md).

Optional `inputs` lists ordered profiles. Each profile requires `selection` with native filters.
The dispatcher selects the first eligible item from the first eligible profile.
Each profile replaces only its named fields: `selection`, `order`, `exclude_tags`, `exclude_children`, `children`, `references`, `related`, `publication`, `wait_for_dependencies` and `batch`.
`wait_for_dependencies` accepts a boolean. Its default is `false`.
Other fields come from the root config. Profiles cannot replace authentication, workflow variables or workspace identity.
Use scalar stage filters in separate profiles. Native `data` arrays mean containment, not alternatives.
Set `children: {}`, `references: []` and `exclude_children: null` to disable inherited context filters.
The launcher freezes the effective profile. It leaves the dispatcher config unchanged.
The assignment contains its zero-based `input` index. A manual launch selects index zero unless `PLANNING_JOPPA_INPUT` supplies another index.
Single-input configs retain their existing behavior.

Set `admission_module` to an absolute ESM file path for an operator-defined eligibility check:

```js
export async function admission(row, effectiveProfile, read) {
  const item = await read('joppa_objects', {address: row.address});
  return item.document.data.stage === effectiveProfile.selection.data.stage;
}
```

Return `true` to admit the row or `false` to skip it. Other return values and errors stop selection.
Only `address`, `revision`, `kind`, `parent` and `title` are guaranteed in every row.
Other list projections differ between paths. Read full objects through `read` when needed.
The supplied reader permits only `joppa_objects`, `joppa_tree`, `joppa_search` and `joppa_help` in the configured workspace.
Reader identity stays stable within one profile selection pass. New passes and direct checks receive a fresh reader.
Modules can cache evidence by reader identity for that pass. The engine does not cache API responses.
Automatic selection skips the item before creating a run folder or claim. Explicit item launches also check admission before execution.
Each batch member passes the check again before the native claim. The check can refuse changed inputs after selection.
The preclaim module process has 30 seconds for the entire batch. Keep its reads bounded.
Input profiles inherit the module path. Existing snapshots preserve the path and effective profile.
Use an immutable module path for each code version. Restart the dashboard after replacing module code.
The module is trusted operator code. The reader restriction does not sandbox its Node process.
Write plain JSON diagnostics to stderr. Keep stdout reserved for the helper response.
Exclude credentials, personal data and workflow signal tags from diagnostics.
Without `admission_module`, selection keeps its existing behavior.

Set `failure_notes: false` to release failed flow claims without adding business notes.
Optionally set `failure_escalation: {"after": 3, "data": {"phase": "owner_decision"}}` to limit repeated technical failures.
Or set `failure_escalation: {"after": 2, "tag": "<vars.STUCK_TAG>"}`: the release save then adds that tag and keeps the other tags.
The tag form counts only released technical failures. A claim refusal neither counts nor ends the series, and a success ends it.
Use field names and values from your workspace schema. Permit saves and notes on the selected kind in the publication policy.
The host counts confirmed failures for the same flow and item from existing run results. Successful publication resets the count.
At the limit, the host saves the configured data, releases the claim and writes the last error in one batch.
Dry runs, active-item skips, uncertain receipts and stops without a confirmed claim do not count.
Without this option, failed flows keep their existing release behavior. Separate run folders keep independent flow histories.
The default is `true`. The frozen config controls failure handlers and shutdown cleanup.
Uncertain receipts still retain the claim for recovery.

For related context, set:

```json
"related": {
  "limit": 90,
  "parent": {"kind": "ac", "exclude_tags": ["hold"], "children": {"kind": "test"}, "references": ["sources"]},
  "incoming": {"kind": "task", "relation": "depends_on"}
}
```

`flow_context.related_context` captures the full parent, its configured children and references, and present incoming consumers.
The assignment adds `context.parent`, `context.children`, `context.references` and `context.incoming`. Native `relations` retain their metadata.
The limit bounds unique related object reads, including archived consumers excluded after their detail read. Related context cannot use `batch`.
The host captures related context again after its own claim. This accounts for parent revisions advanced by child saves.
It refuses held parents and consumers. Archived consumers keep their historical relations unchanged.

Optional `publication.related_updates` adds two narrow permissions: `"parent": ["stage"]` and `"incoming": "remove_selected_edge"`.
The configured `update_kinds` must also permit these targets.
The parent save changes only `data.stage` and uses `context.parent.current_revision`.
A note on that parent requires its preceding guarded stage save in the same output batch.
Permit `note` in `allowed_operations` and the parent kind in `update_kinds`.
This permission does not allow notes on incoming consumers or unrelated nodes.
Task repair can explicitly permit `["stage", "returns"]` or `["stage", "returns", "tags"]` for the parent AC.
`flow_publication.operations` permits one increment of the captured parent counter.
At the configured return limit, a tags update can only add `STUCK_TAG` and preserve every existing tag.
Each consumer save removes only the edge to the selected object. It requires that selected object's archive in the same publication.
Send the complete native relation group after removal. Preserve its title, color, facts and all other edges.
`flow_publication.operations` places the parent save before Task saves and archives. All operations and claim releases share one batch of at most 100 operations.
The host rechecks captured revisions and current present consumer membership before publication.
A new incoming consumer can appear after this check. Native per-object revisions cannot fence that membership race.

Set `concurrency: 3` to run up to three independent passes in one dashboard.
The default is one. The dispatcher reserves each selected address before it starts a process.
Each process keeps its own Medulla run folder, claim and output log.
The existing native claim still checks ownership and revisions.
One dispatcher lock protects the shared runs folder. Do not start three automatic dashboards on that folder.
`--once` and an explicit item, AC or Requirement still run one pass.
In inline mode, the dispatcher accepts config changes after all its active passes end.
Each pass checks its own config digest before publication.
Configured flows release their own claim with the private launch snapshot, even after the live config changes.
Ctrl+C stops Medulla first, then runs the guarded failure release and records `release.json`.
Shutdown allows 10 seconds for Medulla and 30 seconds for the release.
Unconfirmed shutdown, changed ownership or uncertain mutations retain the claim for recovery.
After confirmed shutdown, the launcher reads the current claim holders again.
It can record an observed external release without a tracker write. Uncertain mutation receipts still require recovery.
Failure cleanup can clear this run's assignee at a newer revision. It preserves the newer contract and stage.
It does not apply failure escalation to a node changed since the claim.

To resolve a finished detached run after an operator cleared its assignee, check it first:

```sh
python3 planning-joppa/flow_recovery.py --config /absolute/config.json --run /absolute/launch-folder
```

Add `--apply` to update only its existing local `result.json`. This command sends no tracker writes.
It refuses a live worker, a claim still owned by the run, or an uncertain mutation receipt.
The failure evidence and mutation receipts remain unchanged. The result records the observed revisions and holders.
The legacy Requirement planner keeps its existing shutdown behavior.

Set `"execution": "detached"` for independent configured flow passes.
The default `"inline"` keeps the shutdown behavior above. Changing this option requires a dispatcher restart.
Detached passes use the same process launcher as headless Dolber lanes. They need no Herdr tab or additional container.
Each pass keeps its PID, config snapshot, launch record and `output.log` in its own run folder.
The Medulla run keeps its existing artifacts. The dashboard shows one row for the pass.
The dispatcher identity follows the endpoint, workspace and canonical runs folder.
After a restart, live passes still occupy concurrency slots. The dashboard reads their current stages from their journals.
Ctrl+C stops only the detached dashboard. Live passes keep their claims and continue.
New passes use reloaded configuration, even when older passes remain active.
Each active pass uses its captured config. Its digest, claim, revision and publication guards remain in force.
An uncertain receipt still holds further work. The dispatcher creates no separate history database.
`--once` starts one independent pass and waits for its exit status.
To stop one pass, use the full Run ID or full run folder name:

```sh
sh ./lane-launcher/planner-joppa.sh /absolute/path/to/flow.json --stop-run RUN_ID
```

The command checks the worker PID and signals that process only.
The configured launcher stops Medulla and performs the normal guarded claim release.
Wait for the row to finish. An unconfirmed release shows `HELD` and requires recovery.

The workflow calls `flow_stages.py` through the supplied `CREW_FLOW_STAGES` variable.
`prepare` emits `assignment` and each configured `<role>_contract`.
The assignment contains the full `selected` object, `claim_revision`, configured references, children and schema.
`capture NAME` stores the final agent JSON in `artifacts/NAME.json` and emits the matching variable and `CAPTURED` signal.
Use a distinct name for each parallel input. A hyphen becomes an underscore in the variable name.
`publish` reads the configured publication file from the artifacts directory and sends one native Joppa batch.
`fail` records a short note and releases the claim. It preserves stages, holds and all other business fields.

The publication file contains `{ "operations": [{ "command": { "op": "save_object", "...": "..." } }] }`.
The host supports declared `save_object`, `archive_object` and `note` operations.
New objects must use a configured creation kind and belong to the selected object.
A schema root can instead use an explicit `parent: null` when its kind is in `publication.create_kinds`.
The host creates those roots before the selected-object save, so that save can use native batch references to them.
Updates must use a configured update kind and target the selected object or a captured direct child.
Every update uses its captured revision. For the selected object, use `assignment.claim_revision`.
The host combines a selected-object save with the claim release. Archiving the selected object ends that claim.
A claimed item can emit one save followed by one archive, both with its captured claim revision.
The host archives at the revision of that guarded save. A second save, repeated archive or reversed order is refused.
Without either operation, the host adds a partial claim release to the same batch.
Native data merges preserve unspecified fields. The host refuses moves, whole-document replacements and assignee changes.
It rechecks the schema, references, child membership, revisions and claim before publication.
Reference reads precede the batch. A reference edit inside this interval is not part of the batch revision guard.
An uncertain write retains its receipt and requires recovery. A workflow result never proves acceptance.
A finished run records the revision it left. The retry policy uses that final revision, including the claim release.
Set `batch` to `{ "size": 5, "by": "data.repository" }` to claim up to five matching items of one configured group.
Use `slots` for one dashboard with one active pass per configured filter:

```json
"selection": {"kind": "work", "assignee": "", "data": {"stage": "pending"}},
"slots": [
  {"label": "alpha", "data": {"area": "first"}},
  {"label": "beta", "data": {"area": "second"}}
]
```

Each slot merges its data into the common selection. Nested objects merge, and slot values replace conflicting common values.
Labels must be unique. Use `slots` or `inputs` in a config. The default concurrency is the slot count.
An explicit `concurrency` limits the total active passes. Each slot still permits only one active pass.
The run records its label before execution. Detached passes keep their slot after a dashboard restart or slot reordering.
Each slot can override batch fields with its own `batch` object:

```json
"batch": {"size": 10, "min_size": 3},
"slots": [
  {"label": "alpha", "data": {"area": "first"}, "batch": {"min_size": 1}},
  {"label": "beta", "data": {"area": "second"}}
]
```

The slot fields override the common batch fields. Other slots keep the common batch.
Unknown batch fields and invalid merged values stop configuration loading.
Each detached pass freezes its batch settings. A dashboard restart preserves that snapshot.
An active run with a missing or removed label blocks new passes until its state is resolved.
For a finished detached run with a failure result, use the `flow_recovery.py` command above.
For an unknown run without a result, stop the dashboard first.
Confirm that its worker, Medulla process, and checks have stopped. Resolve its Joppa holders and uncertain receipts before continuing.
Preserve its launch and Medulla folders in a directory outside `runs_folder`:

```sh
mkdir -p /absolute/retained-runs
mv /absolute/runs/LAUNCH_RUN /absolute/retained-runs/
mv /absolute/runs/MEDULLA_RUN /absolute/retained-runs/
```

Move the Medulla folder only when it differs from the launch folder. Keep both folders unchanged.
Restart the dashboard after this operator recovery. Do not create a success result or an exit journal record to clear the block.
Automatic selection assigns slots. A fixed object launch cannot bypass their occupancy guard.
Rows start with `[label]`. The queue shows running passes and waiting units for every slot, including empty slots.
The queue header counts distinct `batch.unit_field` values in captured active batches and waiting items.
Without `unit_field`, it counts object addresses. Captured active units are excluded from waiting.
For example: `queue: 1 waiting (alpha 2 landing / 1 waiting · beta 1 landing / 0 waiting)`.
An uncaptured or unreadable active batch shows `unknown` until its existing input and config establish the units.
Without `slots`, existing selection and concurrency behavior stays unchanged.

Set `min_size` to wait for a minimum batch. Polling still uses `interval_seconds`.
Set `max_wait_seconds` and `age_field` together to release a smaller batch after its oldest timestamp reaches that age.
Alternatively, set `flush_when_idle` to an absolute producer lock glob, such as `/path/to/producer/runs/*/worker.lock`.
Use whole `*` directory segments. Each matching directory uses its sibling `launch.json` to identify the worker PID.
A live PID or unknown run state blocks smaller batches. A missing producer root also blocks them.
Selection and flow preparation check the same locks without changing them.
This option replaces the age condition for smaller batches when both options are present.
Set `unit_field` to count distinct units, such as `data.delivery.branch`, instead of Tasks.
All matching Tasks of each selected unit enter the same atomic claim, up to 50 Tasks.
For example, use `size: 3`, `min_size: 3`, `max_wait_seconds: 900`, and `age_field: "data.delivery.pushed_at"`.
Branch delivery records that timestamp once and preserves it across publication retries.
The first selected item anchors the group. `order` sorts the other members. Omit `by` to use one group.
The native selection filter controls every member, including stage fields. Crew adds no implicit failure-stage filter.
The assignment adds `items` and `claim_revisions`. The entire batch is claimed in one transaction.
Publication can update or archive those claimed items. It clears every claim in the same transaction.
An archive uses the saved revision of its preceding claim release. New objects can belong to any claimed item.
Set `retry` to control automatic retries of configured flow items:

- `"on_revision"` (default): retry only above the highest recorded final revision.
- `"always"`: retry matching items after `interval_seconds`, including after a confirmed failure.
- `"never"`: do not retry an address that has a recorded attempt, even after a revision change.

The dispatcher reads existing run folders. It writes no separate attempt history.
These policies apply to batch anchors. The run records every final item revision.
Another eligible anchor can still include those items as batch members when they match the native selection filter.
The previous `repeat: true` setting means `retry: "always"`. `repeat: false` means `retry: "on_revision"`.
An explicit `retry` takes precedence. Unknown mutation outcomes always hold the dispatcher, for every retry policy.
Active addresses remain reserved. Claims, ownership and revision checks stay unchanged.
Set `retry_by_reason` to override the policy for configured terminal reason codes.
For example, `"retry": "always", "retry_by_reason": {"WAITING_INPUT": "on_revision"}` waits after that refusal.
The dispatcher uses the latest completed outcome at the highest recorded revision for each address.
It compares the selected object's revision, not the revisions of its prerequisites.
A prerequisite change alone does not permit an `on_revision` retry.
Other outcomes retain the default policy. Codes come from the workflow and config, without a built-in refusal list.
Configured reason codes also remain in run history when the panel normally omits selection skips.
Set `retry_delay_seconds_by_reason` to add a minimum delay for an `always` outcome.
For example, `"retry_delay_seconds_by_reason": {"WAITING_INPUT": 900}` retries after at least 15 minutes.
The delay starts at the recorded completion time and survives dispatcher restarts.
The dispatcher also respects the normal polling interval. Revision policies retain their existing meaning.
The publication envelope can add `outcome: { "status": "blocked", "reason_code": "BASELINE_RED", "reason": "..." }`.
This records a stopped business outcome after a confirmed note or claim release. It does not claim acceptance passed.
The generic `verify` stage checks the claimed inputs before an external side effect, such as a Git push.
After receipt recovery, use `retry: "always"` to permit another attempt at unchanged work.

Status: live publication and lane completion passed before native context reads were added.
Native reads pass on four providers. Full native planning publication remains unverified.
Whole-Requirement planning uses generic node operations: `save_object` and `archive_object`.
Joppa removed `assess` and save `links`. Crew reserves a node with `data.assignee` and reads edges from `relations`.
The legacy Task planner requires `FAILED_TASK_STAGE` and validates it against the native Task stage values.
It classifies failed Tasks with this value. Configured flows that do not plan Tasks do not require this key. It preserves that stage during contract edits.
Its provider checks pass. A live grouped run has not passed yet.
Task completion does not confirm criterion acceptance.

Run from the Crew repository:

```sh
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id --dry-run
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id
sh ./planning-joppa/run.sh --config /path/to/private/config.json --req-id requirement:requirement-id
```

Use `config.example.json` as the shape of the private configuration.
Give each repository an ID, a local path, a CBM index and its modules in that configuration.
The bundled planner writes Task scope in `data.repository` and `data.module`.
For these Tasks, set the Dolber config to `"taskFields": {"repository": "data:repository", "module": "data:module"}`.
Dolber does not infer these fields or the planner's body labels without an explicit mapping.
A Task belongs to the repository named by its `Repository:` line. The planner needs no Joppa Project mapping.
Keep credentials and private configuration outside this repository.
Set `mcp_command` to the host connector generated by `broker box connect` for the existing Joppa login.
OAuth stays on the host. Agents use the existing reader wrapper, which refuses mutations and other workspaces.
Publication uses the same user connection from a separate workflow stage.
Existing configurations without `mcp_command` still require separate `token_file` and `reader_token_file` paths.

Show the last 30 planning runs in a terminal table:

```sh
sh ./lane-launcher/planner-joppa.sh /path/to/private/config.json
sh ./lane-launcher/planner-joppa.sh /path/to/private/config.json --ac-id ac:criterion-id
```

The first command groups ready ACs by their schema Requirement and starts one Requirement at a time.
The second command preserves explicit one-AC planning. Use `--req-id` to start an explicit Requirement.
Use `--monitor` to show existing runs without starting work.
The table shows the start time, AC address and text, status, stage or reason code, run ID and elapsed time.
Active runs appear first. The screen updates every five seconds.
Use `--once` to select at most one Requirement and exit after it finishes.
Use `--monitor --once` for one display snapshot.
The table reads existing Medulla journals and results. It creates no history database.
New runs save their output in `output.log` inside the Medulla run folder.
In inline mode, Ctrl+C stops this display and interrupts its own run. It does not stop other runs.
In detached mode, Ctrl+C stops only this display.
The automatic loop checks the queue every 60 seconds. Set `interval_seconds` in the config to change this interval.
The automatic loop reloads the config before each queue selection.
Inline passes wait until all active passes end. Detached passes keep their own config snapshots.
Each pass reads the config file when it starts. Attempt history stays after a reload.
The dispatcher gives each pass the digest of the config bytes it validated (`PLANNING_JOPPA_HANDOFF_DIGEST`).
`launch.py` refuses a file with other bytes before any claim or Medulla start, with exit status 75 (handoff changed, nothing started).
Only then the dispatcher may select the same item again. Other failures stay attempted. The next check reloads the config.
An invalid config shows `CONFIG_INVALID` and starts nothing until the file is valid again.
A change to `workspace`, `url`, `mcp_command` or the resolved `runs_folder` shows `CONFIG_RESTART_REQUIRED`.
Nothing starts until you restore these fields or restart the dispatcher.
It selects criteria in the configured workspace. Repository mappings bound Task publication.
It excludes criteria with active Tasks and criteria whose Tasks are all completed.
It includes a criterion with blocked Tasks even when a sibling Task is completed.
Passing AC tests exclude the criterion from automatic planning.
It plans criteria with blocked Tasks before new work.
Before selection, it checks blocking dependencies on the criterion and its ancestors.
Task targets require completion. AC targets require green tests. Other targets require at least one live AC and all live ACs green.
Archived targets and descendant branches do not block work. A structural parent alone does not block work.
Current dependency pins must remain valid. Priority applies after these checks.
Within each group, it selects failing AC tests before unverified AC tests.
An unchanged failed plan stays skipped. A new Task failure permits another planning attempt.
Set `ac_ids` to an ordered list of full AC addresses to limit automatic planning.
If `ac_ids` is absent, the loop selects eligible criteria across the workspace.
It skips an attempted Requirement revision while its candidate AC and blocked Task revisions remain unchanged.
Restart to try the same unchanged input again.
Unresolved planning receipts prevent another automatic claim. Recover these receipts first.

Requirement planning selects all current ready ACs under one schema Requirement.
It obeys `ac_ids` and excludes green ACs, active worker claims and all unmet blocking dependencies.
The AC status follows its test nodes. An AC without tests is orange and remains a candidate.
This includes dependencies on sibling ACs. A later package plans them after their prerequisites finish.
It reads the Requirement, selected ACs, parents, decisions and existing related Tasks in one native run.
Each planned Task keeps its AC parent and runs and lands independently.
Task titles have numeric prefixes within each repository for display.
New indices follow retained unfinished Tasks' numeric prefixes. Nonselected legacy Tasks keep their deterministic fallback order.
Dependencies on retained Tasks stay external prerequisites. A plan cannot reverse their approved order.
Use blocking `depends_on` links when a Task requires another Task's delivered output, including within one repository.
Independent Tasks have no ordering dependency. Title order does not replace dependencies.
Every selected AC has its own implementation or existing-test-binding disposition and observable acceptance checks.
Claims use one atomic batch. Publication saves Tasks, binds proven tests and finishes changed ACs in one atomic batch.
Unchanged AC contracts release their claims. The Joppa batch limit remains 100 operations.
A claim holds at most 50 ACs: a failure release needs one assignee release save and one critic note for each AC.
The explicit `--ac-id` input preserves the one-AC path.
It also lists unfinished Tasks across Requirements whose `Repository:` line names a configured repository ID, with their module and mechanism. A Task whose `Module:` is not configured for that repository is left out: this planner cannot change it. A Task without a readable module stays listed.
This list locates possible overlap. A full current object read still verifies reuse and dependencies.
Shared modules do not require dependencies unless one Task needs another Task's output.
It reuses related Tasks through dependencies. It edits only Tasks under the selected ACs.
The planner publishes complete implementation mechanisms under their original criteria.
It claims the AC for planning. It uses the shared graph and live Joppa role contracts.
All planning agents can query Joppa for relevant context in the configured workspace and accessible linked workspaces.
The reader exposes the Joppa read tools and rejects writes. Joppa enforces workspace access.
Foreign objects keep their immutable workspace IDs, full addresses and separate schemas in the planning snapshot.
The planner preserves remote links and their status, including inaccessible targets that need review.
It reads captured foreign contracts again before publication. A changed contract, schema or access refuses publication.
It writes Tasks only in the configured workspace. It does not create or update remote dependency pins.
Search results locate objects. Read a full current object before reuse or a dependency.
The existing snapshot records these reads and checks them again before publication.
Runtime MCP configs contain the connector command or a legacy credential file path, never credential values.
Publication remains a separate workflow stage.
Research checks reuse. Necessity checks the minimum scope. Design supplies mechanisms.
Two independent critics review the plan. Publication saves Tasks and finishes the claim in one transaction.
Each Task contract contains Goal, Repository, Module, How and Checks. How has at most five mechanism steps.
New contracts store the goal in `data.body`, scope in `repository` and `module`, and mechanisms in `steps` and `checks` arrays.
Each stored value has at most 1024 characters. Readers reconstruct the full contract and also accept the previous inline format.
An unchanged existing contract keeps its stored format. Task dependencies are sent as the `depends_on` key of `relations`.
Joppa keeps the other relation keys. A changed Task save sends `clean: true`, so a removed field does not survive the merge.
Research citations stay outside Task contracts. Missing tests or behavior require implementation Tasks.
When existing passing tests cover every Then and Evidence item, critics inspect their actual assertions.
The planner binds these tests without creating a verification Task. Each acceptance check supplies
`test` (`file > test name`), `evidence` (`repository:path:line` for assertions and implementation),
and optional `source_ac` when another fully read AC supplies the passing result.
Publication rechecks the recorded pass and its commit ancestry. Cited test and implementation files must remain unchanged.
An unbound test needs a recorded pass on a test node under another AC before this shortcut can use it.
An absent test node never counts as a pass.
An existing node of the AC with a failed or absent result prevents this shortcut.
Each bound test is a child node of the criterion. The node title is the test name.
The workspace schema names the test type with role `test`. Its question, title limit and required fields apply.
The schema `test_results` rules supply the name rule and `max_tests`.
The planner reads all test nodes in pages of 25 and groups them by criterion.
Publication creates only the missing (AC, test name) nodes with `save_object` and revision 0.
It never edits, deletes or recreates an existing node, so recorded results stay.
New nodes and the AC save that releases the assignee go in the same atomic batch.

### Acceptance mapping and shared Tasks

Publication writes `data.acceptance_checks` on each saved implementation Task: `[{ac, check}]`.
Joppa reserves `data.acceptance` for process commands. `data.acceptance_checks` is authored contract context: a change invalidates contract snapshots and digests.
`ac` is the full criterion address. `check` is the rendered acceptance check line that this Task carries.
The list contains only criterion acceptance checks, in scenario or command form. Task-only checks, such as lint or build checks, stay outside.
A lane binds at least one verified test to each entry. Tasks without `data.acceptance_checks` keep their previous behavior.

Set `covers_reference` to the name of one Task schema reference field to let one Task cover several criteria of its Requirement:

```json
"covers_reference": "covers"
```

- The reference must target the criterion type and allow several values. Crew does not change the schema.
- It cannot be `acceptance` (reserved by Joppa for process commands), `acceptance_checks`, `test_bindings` or another Crew data field.
- Without this key the feature is off. A plan with a nonempty `covers` list is then refused.
- A plan Task can list other selected criteria of the same Requirement in `covers`. A covered criterion needs disposition `implement`.
- Its acceptance checks must be in the checks of a covering Task. A covered criterion can then have no Task of its own.
- Crew writes full `kind:id` addresses. A bare ID that Joppa stored as sent reads as an address of the target type.
- The covered criteria are selected, so the planning claim, the idle check, the snapshot and the readiness checks apply to them.
- A covering Task makes its covered criteria owned for queue readiness: an active Task holds them, and a done Task waits for acceptance.
  The queue reads this from the raw Task data of all tones, including archived Tasks.
- Only the parent criterion owns an update or retirement of the Task.
- An unfinished Task under an unselected criterion can carry a covered check only when its `data.acceptance_checks`
  already lists that exact criterion and check. The plan never edits it. Otherwise select its parent criterion
  and update the Task through the normal plan.

A lane completion saves the verified test names in `data.test_bindings` next to `data.commit`.
Planning treats `assignee`, `commit` and `test_bindings` as lifecycle fields, not authored contract.
See `lane-launcher/dolber-joppa.md` for the binding codes.
The planning snapshot keeps each node address, title and revision.
A bound, renamed or replaced node invalidates the plan, even when the AC revision is unchanged.
A new result alone does not invalidate the plan.
Publication uses the captured revision after a freshness check. It does not substitute a newer revision for a stale approved plan.
Joppa orders work by the current target state and does not read `link.revision`.
A pinned revision is valid from 1 through the target's `current_revision`. New `depends_on` links have no pin.
Before the batch, the planner reads each local Task named in `depends_on` once. A done Task is archived with a valid `data.commit`.
A link to a done Task stays unchanged, and no new link to it is added. A missing or retired target refuses publication.
An older server refuses the batch before any write. Already valid bindings release the planning claim without a new revision.
The planner does not run tests or mark acceptance as passed. A full report supplies acceptance results.
Publication does not confirm acceptance or mark the AC as passing.
Clean code changes do not invalidate a mechanism plan. Publication rechecks current source and role contracts.
It revalidates the plan against live Joppa context. Changes to the AC, its context or reviewed Tasks still prevent publication.
Uncommitted source changes still prevent publication. Lane checks the current code before implementation.
The current source must descend from the prepared base. Planned module and check directories must still exist.
The result records both prepared and current source snapshots.

A module can define `paths` for its writable roots, such as production code, required tests and migrations.
Its `path` remains the working directory. Without `paths`, the module uses `path` as its sole writable root.

Joppa has no Task workflow commands. The planner uses generic node fields:

- Claim: one `joppa_batch` saves each selected AC with its full document and
  `data.assignee` `crew-planning:<host>:<run_id>` at the revision read for the plan.
  A stale revision refuses the whole batch. The planner reads the holders again and stops.
- Ownership: the claim receipt records the revision that this run wrote for each AC.
  Before publication or release, the planner reads each AC again. It requires its own
  `data.assignee` value and that exact revision. A later edit or reassignment stops the run.
- Every `note` follows a revision-checked save of the same object in the same batch.
- Saves are partial: `data` holds only the changed fields, `null` removes a field. Joppa keeps the parent and every relation key that is not sent.
- Lists exclude archived nodes. Ended Tasks are read only by a known address, such as a link target.
- Release: save `data.assignee: null` on the AC at its current revision.
- Finish: the publication batch saves Tasks and saves each AC with `data.assignee: null`.
- A revised failed Task keeps its current stage. Planning never returns it to a working stage.
- Retirement archives the Task with `archive_object` and no `data.commit`.
- Task state: `data.assignee` on a live Task is active work. `FAILED_TASK_STAGE` identifies failed work.
  The Task note and run receipt keep the failure code and details. An archived Task with `data.commit` is done; without it, retired.
- The contract digest excludes `data.assignee` and `data.commit`. Every other authored field stays.
  A child AC save gives its Requirement a new revision with the same authored fields. Ancestor
  snapshots compare authored fields, so that revision alone does not stop the run.

The planner refuses before claiming if `save_object` or `archive_object` is absent.
Refresh the canonical source before launch. Prepare checks every CBM project root first.
Then it reindexes each shared CBM project and refuses if the source moves.
It holds the lane `<repo>/.git/sync.lock` for one repository at a time and uses `mode: moderate`.
`persistence: false` only skips the `.codebase-memory/graph.db.zst` snapshot. The shared index store persists.
Verify indexed paths in the inspected source. Do not index an isolated checkout.
Lifecycle saves raise a revision above earlier dependency pins. Such pins stay valid.
Retirement removes blocking links to the retired Task from remaining Tasks.
Keep required dependencies explicit. Never remove them to make a Task available.
Dry-run validates configuration without MCP calls, agent calls or writes.
The dashboard starts the next Requirement after each run.

Crew planning updates only unclaimed implementation Tasks.
It can retire a blocked, unclaimed Task under the held AC.
The same publication removes blocking links to that Task from remaining Tasks.
It preserves completed and retired Tasks.
Before publication reopens a blocked Task, the planner discards its retained checkout.
Set `worktree_root` to the Dolber worktree root and `lane_runs_folder` to its dispatcher runs directory.
When Tasks of one workspace use more than one dispatcher, set `lane_runs_folders` instead.
It is a nonempty list of absolute dispatcher runs directories. Do not set both fields.
Cleanup reads every listed folder before it deletes a checkout.
A Run ID in more than one folder stops cleanup. No runs folder can be inside a checkout that cleanup deletes.
Cleanup requires a block Run ID and finished failed lane receipts for that Task.
Active, held and unconfirmed successful runs prevent cleanup. The planner never archives the checkout.
It deletes no checkout unless the publication updates or retires its blocked Task.
`WORKTREE_PREEXISTED` follows the normal failure path. The planner never retries it automatically.
Cleanup requires a matching failure note, a confirmed receipt, a terminal run and revision-checked contract updates.
A stage-only retry is refused. An owner or an authorized role controls a later stage change.
Cleanup precedes one atomic batch that marks the Tasks ready and finishes planning.
An uncertain publication retains its receipt and claim for recovery. Other failures use the normal planning graph.
It skips unchanged documents and pins dependencies from the fresh context.
Before each claim, it checks previous receipts for this endpoint, workspace and AC.
Unresolved receipts block a new run. They require explicit recovery.
Confirmed failures release this run's planning claim. Uncertain mutations retain their request receipts.
The planner refuses publication when a blocked Task keeps its contract and is not retired.
The refusal `blocked Task needs a new contract or retirement` retains the claim and reports `BLOCKED`.
Any other rejected publication applied nothing. Failure release removes the assignee and keeps the AC stage.
The note and receipt record the failure code.
When a critic rejects the plan after the last revision round, the same release batch adds one native Joppa `note`
to each released AC. Its id has at most 120 ASCII bytes and ends with a digest of the AC address.
The note has the run ID, the plan digest prefix and at most three blocking findings
(claim and resolution, with the critic seat). The next planning pass reads it as AC context. It is evidence to
verify against current code, not an instruction. Only the explicit critic rejection of the current plan writes it.
Other failures, stale or malformed verdicts and ACs that the release skips get no note.
`release.json` records `critic_notes`, or `critic_notes_dropped: "batch"` when the batch has no space for notes.
Inspect `claim.json`, `publication.json` and `release.json` before recovery.
Use the recorded request ID and identical arguments if manual recovery requires a receipt replay.
Never start another mutation blindly. A planning `data.assignee` does not expire.
An interrupted process can retain a claim. Release it explicitly after checking its publication receipt:
save the AC without `data.assignee` at its current revision.

Current limits:

- A human can edit an unclaimed implementation Task. Crew can replace that contract if its reviewed revision still matches.
- A plan with unchanged Task contracts releases the claim. It keeps the current stage. A later run can select the AC when the native filter permits it.
- Receipt checks compare endpoint URLs exactly. Keep the same URL, including its trailing slash, across runs.

Run the focused provider checks:

```sh
cd planning-joppa && python3 -m pytest -q tests
```
