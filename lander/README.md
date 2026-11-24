# Lander

Lander integrates checked Task branches through the existing configured dispatcher and Medulla.
It uses no model, separate queue, or claim store.

```sh
sh lane-launcher/lander.sh /absolute/lander.json
sh lane-launcher/lander.sh /absolute/lander.json --once
```

Start from `config.example.json`. Replace its native kinds, stages, filters, commands, and paths with your configuration.
The example selects at most five pending Tasks from one repository every 30 minutes.
Use the native `selection` filter to control eligibility. Crew adds no project or hold filter.

## Input

Use Dolber `delivery: branch`, explicit focused `reviewCommands`, and `pendingDeliveryData` for the waiting stage.
A successful branch publication keeps the Task live, clears its assignee, and records its repository and checked commit.
Its `data.delivery` contains `state: pending`, `branch`, `head`, `target`, the producer run ID, and `pushed_at`.
The timestamp records the confirmed branch handoff and stays fixed across publication retries.
Coder selection skips pending delivery. Only Lander archives a Task after target integration.
Lander saves `DONE_TASK_STAGE` before the archive in the same guarded publication batch.
The default is `done`. The Task schema must permit that editable value.

The Lander config supplies repository paths, target branches, full gate commands, and an optional setup command.
The commands select their runtime. Docker projects must supply Docker commands or a project wrapper.
Git uses the launch environment. A configured `vars.GIT_SSH_COMMAND` can select an existing private key.
No credentials belong in the public configuration example.

## Flow

1. The shared stage selects and claims the configured batch atomically.
2. Lander pins each declared head and creates one private integration checkout.
3. It merges the branches with commit ancestry preserved and runs the full configured checks once on a green batch.
4. The shared stage checks the input revisions again. Lander rechecks the remote heads and pushes normally.
5. Native publication archives only heads proven in target ancestry and releases every claim. Cleanup removes the integration checkout.

The canonical source repository stays unchanged. Repository hooks remain enabled.
Use `batch.min_size: 3` and `batch.unit_field: "data.delivery.branch"` to wait for three distinct branches.
Set `batch.max_wait_seconds: 900` and `batch.age_field: "data.delivery.pushed_at"` to flush smaller batches after 15 minutes.
Set `interval_seconds: 60` to check the queue every minute. All Tasks of each selected branch enter the same claim.
Existing gate receipts and `lane/bin/land.sh` protect the push.
The workflow has one deadline of 3600 seconds and sets no node timeouts.
Native `on_timeout` runs `failed` once to release claims and clean the integration checkout.
The configured gate timeout also bounds each command, including repository hooks.

## Failures

With retained branches, `repair_budget` can name `{ "field": "repair_attempt", "max_attempts": 2, "exhausted_tag": "stuck" }`.
Match this policy to Dolber. Include its tag in `exclude_tags`.
A red branch at that budget receives the tag and an owner review note. A passing branch can still land.

A red combined check first requires a target baseline check.
A red baseline leaves all branches pending. It does not identify a faulty Task.

### No new red (opt-in)

A repository can allow landing on a red target when the candidate adds no test failure:

```json
"testReport": {"path": "junit/report.xml", "format": "junit", "identity": "{classname}.{name}"},
"noNewRed": {"testCommand": "<the exact last entry of gateCommands>"}
```

The last gate command is the designated test command. Every earlier command must pass.
Its runner must write a complete fresh JUnit report to `$CREW_TEST_REPORT_DIR/<path>`.
Exit 0 means every test passed. Exit 1 means the run completed with test failures only.
Any other exit, a timeout, a missing, stale or ambiguous report, or a report that disagrees with the exit refuses.

`lane/bin/no_new_red.py` compares the candidate receipt with the red baseline receipt of the same target tree:
the same commands, report settings and scope; every test executed on the baseline is executed on the candidate;
no new skipped test; the candidate failures are a subset of the baseline failures.
The batch, the separate branch checks, the combinations and a target rebuild use the same comparison.
Before the push, `gates.py verify` compares both receipts again from a digest-bound proof,
and `land.sh` refuses unless the target still equals the baseline target. Tests do not run again for the proof.
Lander records nothing as an accepted test result. Without `noNewRed`, a red baseline stays `BASELINE_RED`.
For a green baseline, Lander checks branches separately and then builds a passing combination.
An interaction failure names an incompatible combination. It does not accuse a branch that passed alone.
Previously checked exact candidates reuse their receipts.
After a cached candidate is restored, its configured setup restores ignored dependencies before the push. Full checks do not repeat.

A failed branch receives `vars.FAILED_DATA`, a cleared delivery field, and an evidence note.
The patch must use the project's native fields. It cannot override the assignee, commit, repository, or delivery metadata.
Original remote branches remain available for repair.
Set `retain_failed_delivery: true` to keep a failed branch pending for a separate repair claim.
In this mode, `vars.FAILED_DATA` must preserve the stage and supply nonempty `tags` included in `exclude_tags`.
Lander adds these tags to the existing tags. It preserves the delivery branch, checked head, commit and failure evidence.
The ordinary Dolber still skips pending delivery. Repair must produce a new reviewed and checked head before resubmission.
A moved target permits one rebuild and a new full check. A second move leaves the remaining work pending.
A moved or unavailable branch is excluded before the push. Its pending delivery stays unchanged with an evidence note.
With `repeat: true`, Lander retries that pending head each interval until the producer records a current reviewed head.

A partial landing reports `PARTIAL_LANDING`. Landed Tasks are archived, and excluded Tasks retain the repair evidence.
An uncertain native write requires receipt recovery before another claim.
A landed Task does not prove criterion acceptance. The workflow never writes a passing acceptance result.

## Hourly report

Run `node lander/report.mjs /absolute/lander.json` from an existing timer.
The command only reads the pending queue and local run evidence.
It prints pending branch counts, batch sizes, outcome codes, and measured push-to-landing seconds for the last hour.
A missing timestamp remains unmeasured. An unconfirmed native publication remains explicit in the report.

## Monitor

```sh
sh lane-launcher/lander-status.sh /absolute/lander.json /absolute/run-stats.jsonl
```

The optional JSONL file is the existing run collector output.
The monitor shares Dolber's table renderer and reads native run files every five seconds.
It shows the claim time, distinct branch count, Task IDs, current stage, outcome, and elapsed time.
An active build shows `full check` when its gate artifacts exist.
Green requires confirmed target ancestry and native publication. The monitor writes no data and takes no dispatcher lock.
Use `--once` to print one snapshot without an interactive screen.
