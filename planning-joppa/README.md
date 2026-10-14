# Joppa planning

Status: live publication and lane completion passed before native context reads were added.
Native reads pass on four providers. Full native planning publication remains unverified.
Task completion does not confirm criterion acceptance.

Run from the Crew repository:

```sh
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id --dry-run
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id
```

Use `config.example.json` as the shape of the private configuration.
Map Joppa Project addresses to local repositories and CBM indexes in that configuration.
Keep credentials and private configuration outside this repository.
Set `reader_token_file` to a Joppa token that permits only reads.
Keep `token_file` for the workflow publication stage. Do not reuse this token for agent MCP.
The planner refuses before claiming if the reader token file is absent.

Show the last 30 planning runs in a terminal table:

```sh
sh ./lane-launcher/planner-joppa.sh /path/to/private/config.json
sh ./lane-launcher/planner-joppa.sh /path/to/private/config.json --ac-id ac:criterion-id
```

The first command selects ready ACs and plans one at a time. The second starts one AC.
Use `--monitor` to show existing runs without starting work.
The table shows the start time, Requirement and AC titles, status, stage or reason code, run ID and duration.
Active runs appear first. The screen updates every five seconds.
Use `--once` to select at most one AC and exit after it finishes.
Use `--monitor --once` for one display snapshot.
The table reads existing Medulla journals and results. It creates no history database.
New runs save their output in `output.log` inside the Medulla run folder.
Ctrl+C stops this display and interrupts its own run. It does not stop other runs.
The automatic loop checks the queue every 60 seconds. Set `interval_seconds` in the config to change this interval.
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
It skips an attempted AC revision while its blocked Task revisions remain unchanged.
Restart to try the same unchanged input again.
Unresolved planning receipts prevent another automatic claim. Recover these receipts first.

The input is one AC. The planner reads its Requirement, parents, decisions and sibling ACs and Tasks.
It also lists unfinished Tasks across Requirements in the configured repository projects, with their module and mechanism.
This list locates possible overlap. A full current object read still verifies reuse and dependencies.
Shared modules do not require dependencies unless one Task needs another Task's output.
It reuses sibling Tasks through dependencies. It edits only Tasks under the selected AC.
One AC is the smallest native planning unit. The planner publishes complete Tasks under that AC.
The owner prepares smaller ACs when the criterion needs separate planning runs.
NTK supports shallow ticket splitting before design in its separate workflow.
It claims the AC for planning. It uses the shared graph and live Equill roles.
All planning agents can query Joppa for relevant context across the configured workspace.
The reader exposes eight read tools. It rejects writes and reads of other workspaces.
Search results locate objects. Read a full current object before reuse or a dependency.
The existing snapshot records these reads and checks them again before publication.
Runtime MCP configs contain the credential file path, never its value.
Publication remains a separate workflow stage.
Research checks reuse. Necessity checks the minimum scope. Design supplies mechanisms.
Two independent critics review the plan. Publication saves Tasks and finishes the claim in one transaction.
Each Task contract contains Goal, Repository, Module, How and Checks. How has at most five mechanism steps.
Research citations stay outside Task contracts. A verification Task checks existing behavior.
Publication does not confirm acceptance or mark the AC as passing.
Clean code changes do not invalidate a mechanism plan. Publication rechecks current source and Equill roles.
It revalidates the plan against live Joppa context. Changes to the AC, its context or reviewed Tasks still prevent publication.
Uncommitted source changes still prevent publication. Lane checks the current code before implementation.
The current source must descend from the prepared base. Planned module and check directories must still exist.
The result records both prepared and current source snapshots.

A module can define `paths` for its writable roots, such as production code, required tests and migrations.
Its `path` remains the working directory. Without `paths`, the module uses `path` as its sole writable root.

The deployed server must support `claim_planning`, `finish_planning` and `release_planning`.
The planner refuses before claiming if those commands are absent.
Refresh the canonical source and its shared CBM index before launch.
Verify indexed paths in the inspected source. Do not index an isolated checkout.
The deployed server keeps Task dependency pins current through claim and completion events.
Contract changes and retirement still invalidate those pins.
Keep required dependencies explicit. Never remove them to make a Task available.
Dry-run validates configuration without MCP calls, agent calls or writes.
The planning engine handles one AC per run. The dashboard selects the next AC after each run.

Crew planning updates only unclaimed implementation Tasks.
It can retire a blocked, unclaimed Task under the held AC.
The same publication removes blocking links to that Task from remaining Tasks.
It preserves completed and retired Tasks.
Before publication reopens a blocked Task, the planner discards its retained checkout.
Set `worktree_root` to the Dolber worktree root and `lane_runs_folder` to its dispatcher runs directory.
Cleanup requires a block Run ID and finished failed lane receipts for that Task.
Active, held and unconfirmed successful runs prevent cleanup. The planner never archives the checkout.
It deletes no checkout unless the publication updates or retires its blocked Task.
It skips unchanged documents and pins dependencies from the fresh context.
Before each claim, it checks previous receipts for this endpoint, workspace and AC.
Unresolved receipts block a new run. They require explicit recovery.
Confirmed failures release this run's planning claim. Uncertain mutations retain their request receipts.
An unchanged blocked Task must pass the server's `finish_planning` check.
The refusal `blocked Task needs a new contract or retirement` retains the claim and reports `BLOCKED`.
Inspect `claim.json`, `publication.json` and `release.json` before recovery.
Use the recorded request ID and identical arguments if manual recovery requires a receipt replay.
Never start another mutation blindly. Planning claims do not expire.
An interrupted process can retain a claim. Release it explicitly after checking its publication receipt.

Current limits:

- A human can edit an unclaimed implementation Task. Crew can replace that contract if its reviewed revision still matches.
- A plan with unchanged Task contracts releases the claim. It does not finish planning, so another run can select the AC.
- Receipt checks compare endpoint URLs exactly. Keep the same URL, including its trailing slash, across runs.

Run the focused provider checks:

```sh
python3 -m unittest discover -s planning-joppa/tests
```
