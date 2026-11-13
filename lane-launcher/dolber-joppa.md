# Dolber with Joppa Tasks

Run from the Crew directory:

```sh
sh ./lane-launcher/dolber-joppa.sh ./lane-launcher/my-project.json --dry-run
sh ./lane-launcher/dolber-joppa.sh ./lane-launcher/my-project.json --once
sh ./lane-launcher/dolber-joppa.sh ./lane-launcher/my-project.json
```

Copy `dolber-joppa.example.json` to your local config. Local JSON configs are ignored by Git.
Set the workspace, repositories, modules, checks, mounts, image and lane limit there.
One authenticated worker can serve all lane slots. Set their number with `limit`.
Keep credentials outside every mounted directory.

## Execution

Dolber and the planner queue use the same Node.js MCP client. Their queue calls do not start a Python process.
Dolber selects available Tasks whose `Repository:` declaration matches a configured repository ID.
Joppa project membership does not filter Tasks. Dolber skips missing or unknown repository declarations without changing the Task.
It opens a Herdr tab in the current workspace. Its worker claims that exact Task before preflight or Docker.
A claim refusal stops that worker. An uncertain claim remains reserved until you inspect it.
The continuous dispatcher still checks for other work.

The queue checks blocking `depends_on` targets on each Task and its ancestors.
Archived targets satisfy a dependency. A live Task needs `data.stage: done`; other live targets need a green status.
The queue skips completed Tasks. The claim also refuses them.
Local revision pins must be positive integers. Remote dependencies retain their access and revision checks.

The Task contract must declare exactly one `Repository:` line and one `Module:` line.
These names select entries in the config. Module paths remain inside the selected repository.
The lane reads a snapshot of the claimed Task. Joppa credentials stay on the host.
The snapshot includes the direct parent as acceptance context. The Task contract defines the execution scope.
Completion checks that both authored documents remain unchanged.
The existing lane runs discovery, implementation or verification, configured checks and independent review.

`delivery: "branch"` publishes the checked candidate to `ticket-<execution-id>-<run-id>`. It does not merge or deploy.
`delivery: "target"` lands the candidate on the configured `targetBranch`.
`delivery: "requirement"` keeps one branch for each Requirement and repository.
Each Task uses that branch and merges the current target before implementation.
Each Task runs `reviewCommands` and expert review before publication.
Set `reviewCommands` to lint and focused tests for the Task change.
Intermediate Tasks complete on the Requirement branch. They do not run full gates or `afterLand`.
The last Task runs full `gateCommands` under the shared target lock before target delivery.
Crew checks the live Task set again before this push. A changed set or active planner prevents delivery.
Failed final gates retain the last Task checkout and block that Task.
The failed Task does not publish its changes to the shared Requirement branch.
The planner must create scoped repair work. Crew does not reopen completed Tasks.
If retirement leaves only completed Tasks, Crew selects the unpublished Requirement branch for finalization.
This run executes full gates and target delivery without a Task claim or agent nodes.
A failed finalization records one Requirement note request per source head, target head and Task context.
Merge conflicts and failed full gates wait until the source, target, or Task context changes.
Other failures retry after 60 seconds. Existing run results supply the retry time.
A repeated finalization checks target ancestry under the lock and skips checks and push if the code already landed.
This mode requires `sharedLockDir` and a server-enforced read-only `joppa.readerTokenFile`.
Crew mounts a temporary copy of that reader token. Worker mutation tokens stay on the host.
The host confirms the remote SHA before it saves `data.commit` and archives the Task in one batch.
The command sends that SHA in `commit`. The host then checks the returned Task commit.
An existing-code check sends the verified remote SHA. It does not create a commit.
A completed Task records delivered work. Criterion test results decide acceptance separately.
Each nonempty Requirement head must match a current DONE Task publication before another run adopts it.
Crew also checks the Task holder, contract and planning ownership immediately before an intermediate push.
After any failed intermediate run, Crew checks the remote Requirement head.
If it changed, Crew records `REQUIREMENT_HEAD_UNCONFIRMED` in the log and a Requirement note.
Inspect the saved completion request. Retry that request only when its Task contract remains unchanged.
If the contract changed, the operator must restore the prior Requirement head. Crew never force-pushes a rollback.
For target delivery, it also accepts the checked SHA as an ancestor of the current target.
Joppa `done` records execution. It does not accept the AC or Requirement.

### Covered criteria

With `joppa.coversReference`, a claimed Task can cover other criteria of its Requirement.
Before the claim, each covered criterion must be present, without a `data.hold` code, without assignee and without unmet dependencies.
Otherwise Dolber claims nothing and reports `COVERED_CONTEXT_NOT_READY`.
After the claim, Dolber reads each covered criterion again and stores its revision and digest as acceptance context.
A change in this window releases the claimed Tasks before startup with the same code.
The startup guard and completion require each saved acceptance context unchanged and without unmet dependencies.

## Failure

Dolber blocks confirmed failures with evidence and releases their claims.
An uncertain claim or outcome stays held until inspection confirms the result.
The reservation holds only its Tasks. Other Tasks of the same Requirement and repository can run within the lane limit.
Unused and unchanged worktrees are removed. Failed worktrees with changes remain for recovery.
A lost completion response requires inspection. Do not rerun code which was already published.
Completion failures also write a Joppa note. Branch delivery uses a separate candidate branch for each retry.

## Config fields

| Field | Purpose |
|---|---|
| `limit` | Maximum concurrent lanes, independent of the number of authenticated workers |
| `joppa.workers` | Authenticated actors and host token files. One entry can serve all lane slots |
| `joppa.readerTokenFile` | Private read-only token for final Requirement context checks |
| `repositories` | Map contract names to source paths, branches, CBM projects, modules and checks |
| `reviewCommands` | Optional checks before expert review. A repository value overrides the dispatcher value. Defaults to `gateCommands`; full gates run before push |
| `gateTimeoutSeconds` | Maximum seconds per check, default 900. A repository value overrides the dispatcher value |
| `coderTimeoutSeconds` | Optional cap per coder attempt. A repository value overrides the dispatcher value. Omit it to keep the workflow limit |
| `preflight` | Run the configured repository executable in the private checkout, or use `null` |
| `afterLand` | Optional host executable relative to the canonical repository. Run after successful target delivery, before checkout removal |
| `delivery` | `branch`, `target`, or `requirement` |
| `testReport` | Optional per repository. Record the JUnit results of the final gate run in Joppa. See below |
| `joppa.coversReference` | Optional Task reference field that lists covered criteria. Use the planner `covers_reference` value. It cannot be `acceptance`, `acceptance_checks` or `test_bindings` |

`sourceRoot` can contain several repositories or be the repository itself.
Only configured repositories enter Git and CBM refresh.
Set each repository's `cbmProject` to the canonical project name returned by CBM.
Startup requires that name and the indexed root path to match the configured repository.
`worktreeRoot` sets the checkout directory inside `sourceRoot`. Each Task has a stable execution ID.
The table shows the full Task address, stage or reason code, run ID, start time and duration.

`coderTimeoutSeconds` requires Medulla support for `--node-timeout` in the host runtime and the selected image.
Medulla 4.98.1 rejects this flag. Omit the setting with that release.
Dolber checks host support before reading or claiming a Task. The cap cannot extend the workflow's coder timeout.
It does not limit expert review or landing. A resumed run keeps its saved cap.
Config changes apply only to new claims. Existing runs keep their captured arguments.

### Reconcile a manually released startup failure

Use this command only for a finished branch-delivery run that failed before the native workflow started.
Stop dispatch for this project first. Confirm the Task release in Joppa. Remove the unsupported timeout setting before another launch.
Run this command from the Crew directory. Supply the old run's `launch.json` path.
The handler checks the checkout, process group, containers, native run folder and current Task contracts.
It preserves the failed result and existing requests. It does not start a lane.

```sh
node --input-type=module --eval '
import fs from "node:fs";
import path from "node:path";
import {readRun, save, alive} from "./lane-launcher/runtime.mjs";
import {api, finishTask} from "./lane-launcher/joppa.mjs";
const file = path.resolve(process.argv[1]), run = readRun(file);
if (run.config.source !== "joppa" || run.config.delivery !== "branch" || run.finalizeOnly ||
    run.result?.status !== "failed" || !run.result.finishedAt || alive(run.worker?.pid) ||
    run.completionRequest || run.blockRequest || run.releaseRequest || run.recovery || run.recoveryNoteRequest) {
  throw new Error("Inspect this run before recovery");
}
const lock = path.join(path.dirname(file), "worker.lock");
fs.mkdirSync(lock);
try {
  for (const claim of run.claim.tasks || [run.claim]) {
    const task = await api(run.config, run.joppaWorker, "joppa_objects", {workspace: run.workspace, address: claim.address});
    if (task.address !== claim.address || task.process?.status !== "open" || task.process.assignee !== null) {
      throw new Error("Task release is not confirmed");
    }
  }
  const result = {...run.result};
  await finishTask(run, file, result, null);
  if (!run.releaseConfirmed) throw new Error("Startup release is not confirmed");
  run.result = {...result, released: true, held: false, blocked: false,
    tasks: run.releaseResults, recoveredAt: new Date().toISOString()};
  save(file, run);
  console.log("Release confirmed. Failed result preserved.");
} finally {
  fs.rmdirSync(lock);
}
' /absolute/old/run/launch.json
```

Expert review uses the receipt for `reviewCommands`. Landing replaces
`artifacts/gates/current.json` with the full gate receipt before push.
Earlier receipts remain in their existing directories.
Requirement delivery runs full gates only before final target delivery.

Before Docker, each new worker checks the exact publication SHA of completed prerequisites.
Tasks in the same Requirement and repository can use their shared Requirement branch in this mode.
Other consumers require that SHA on the prerequisite repository's configured target branch.
Missing publication evidence or an unlanded SHA releases the new claim before any repository code runs.
Upgrade all Task consumers together. A consumer that trusts only `done` can read unpublished code.

`afterLand` receives four arguments: checkout path, landed SHA, target branch, and the target SHA before this push.
The fourth argument defines the complete delivered change range, including all Task commits after rebase.
Older workers supply only three arguments. A hook that needs the range must reject a missing fourth argument.
If the target has no previous commit, Crew skips the hook and retains the checkout for inspection.
Crew uses the hook version in the canonical checkout when the lane ends.
Its working directory is the checkout. It has 120 seconds, followed by a five-second stop limit.
It must use existing check results. It must not change HEAD or source files.
Crew checks HEAD and Git status afterward. A failed hook retains the checkout and records `POST_LAND_FAILED`
in the run result, table and notification. The log and result include the retry command.
Confirmed Task completion remains valid. A completed Task's retained checkout does not occupy its Requirement group.
Branch delivery and verification without a push do not run this hook.

### Landed test results

`testReport` is optional for each repository. Without it, Crew records no test results.

```json
"testReport": {"path": "junit/report.xml", "format": "junit", "identity": "{file} > {name}"}
```

- Each gate run creates a new, empty folder and exports it as `CREW_TEST_REPORT_DIR`.
- A gate command must write the JUnit XML file to `$CREW_TEST_REPORT_DIR/<path>`. Crew runs no extra tests.
- `identity` builds each test name from attributes of the `testcase` element, for example `{file} > {classname}.{name}`.
  `{suite.file}` reads the nearest `testsuite` element. Crew does not infer a file path from `classname`.
- The gate receipt keeps the report SHA-256 and the parsed results. A report problem does not change the gate verdict.

Crew records nothing and writes a `TEST_RESULTS_NOT_RECORDED` diagnostic in the log and run state when:

- the report is missing, empty, not valid XML, or older than the gate run,
- two test cases have the same name, or a name fails the workspace `test_results.name` rule,
- the landed SHA tree differs from the tree in the gate receipt (`TEST_RESULTS_TREE_MISMATCH`),
- the receipt is not the full `gateCommands` run.

Crew records results only after a confirmed landing on `targetBranch`.
Branch delivery, intermediate Requirement Tasks and verification without a push record nothing.
The host sends `joppa_record_results` once for the landed SHA, in batches of `test_results.max_results`.
`failure` and `error` give the fail status with the message in `failure_field`.
`skipped`, `status="notrun"`, `result="skipped"` and `result="suppressed"` give the skip status.
An unknown `status` or `result` value refuses the report. Only other executed cases give the pass status. `time` gives `duration_ms` when the schema has that number field.
Crew records only cases in the report. Crew does not change test lists or criteria.
Recorded results are test evidence. They do not accept a criterion or a Requirement.

### Test bindings

A Task with `data.acceptance_checks` (`[{ac, check}]`, written by the planner) needs lane test evidence.
The ticket gives these rows as `testAcceptance`. The coder writes `artifacts/test-bindings.json`:
`[{task, ac, check, test}]`. Each (task, AC, check) needs at least one verified test name. Several names are allowed.
Identical rows are removed. The bound pairs must equal the union of `data.acceptance_checks` in the package.

- Before the claim, Dolber bounds both outcome batches: `max(3 * N, 2 * N + B) <= 100`.
  `N` is the Task count. `B` is the count of distinct required (AC, test) node saves.
  Before names exist, `B` is the count of distinct (AC, check) rows in `data.acceptance_checks`: one new node for each row.
  A larger package claims nothing: `PACKAGE_BUDGET`. The lane gets the remaining node limit as `bindingNodeLimit`.
- Before the claim, each `data.acceptance_checks` row must name the Task parent or a covered criterion, and one of the
  Task checks. Otherwise Dolber claims nothing: `BINDING_INVALID`. Completion checks this again.
- Dolber validates only the explicit `testReport` config. The gate receipt proves that a report exists.
- Each passing `gates.py run` binds its own receipt before it becomes current, and each run drops an earlier record.
  This includes the full gates of a landing. `prepare_review` also runs `gates.py bindings` for the current receipt.
  No check runs again. Each name must be in that report with outcome pass. The record
  `artifacts/test-bindings-receipt.json` binds the file SHA-256 to the receipt SHA-256, tree and candidate.
  A refusal returns the work to the coder.
- At completion, the host recomputes every check. The record must name the receipt in `artifacts/gates/current.json`.
  A changed file, receipt or row refuses completion with `BINDING_FROZEN_MISMATCH`.
  The completion batch saves `data.test_bindings` next to `data.commit` and creates each missing test node
  under its exact AC, after the saved contexts check. A saved request must contain exactly the recomputed node saves
  (type, parent, title, owner) and Task bindings. Dolber reads each created node again. An existing node is never changed.
- Joppa limits each changed scalar value, also inside lists. Each binding value has at most 1024 characters.
- At the final target landing, Dolber reads the done Tasks of the Requirement and repository with `data.test_bindings`.
  Each name must be in the full `gateCommands` report, and its node must be under its exact AC. Then Dolber records
  the results and reads each bound node again. Each needs a result at the landed SHA.
- Repositories without `testReport`, verification runs and Tasks without `data.acceptance_checks` keep their behavior.
  The run log and result show the gap. No report means no test acceptance.

| Code | Meaning |
|---|---|
| `BINDING_MISSING` | No binding file or record, or a Task without `data.acceptance_checks` |
| `BINDING_INVALID` | An acceptance row names an AC outside the parent and covers or a check outside the Task checks, or the bindings have a wrong shape, differ from `data.acceptance_checks`, or break the test node rules |
| `BINDING_NOT_IN_REPORT` | A bound name is not in the reviewed or the full gate report |
| `BINDING_NOT_PASSED` | A bound name does not pass in the reviewed report |
| `BINDING_FROZEN_MISMATCH` | The file, receipt, tree or rows changed after the bindings step |
| `BINDING_NO_REPORT` | The receipt gives no usable test report, or the repository has no `testReport` (a gap only) |
| `BINDING_NODE_MISSING` | The final landing finds no node with the name under its AC |
| `PACKAGE_BUDGET` | The failure or completion batch would exceed 100 operations |
| `COVERED_CONTEXT_NOT_READY` | A covered criterion is not live, unheld and ready |
| `TEST_RESULTS_UNBOUND` | The record reply lists a bound name as unbound |
| `TEST_RESULTS_MISSING` | A bound node has no result at the landed SHA after the record |

Each code is an evidence gap. None of them makes a criterion green.

The run state `testResults` keeps each exact request before Crew sends it.
A lost response marks the request `uncertain` and Crew never sends it again.
Inspect the test nodes with `joppa_objects` before a manual retry.
A failed publication does not change the landed lane result and does not run the lane again.
