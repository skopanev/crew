# Dolber with Joppa Tasks

Run from the Crew directory:

```sh
sh ./lane-launcher/dolber-joppa.sh ./lane-launcher/my-project.json --dry-run
sh ./lane-launcher/dolber-joppa.sh ./lane-launcher/my-project.json --once
sh ./lane-launcher/dolber-joppa.sh ./lane-launcher/my-project.json
```

Copy `dolber-joppa.example.json` to your local config. Local JSON configs are ignored by Git.
Set the workspace, Joppa project address, repositories, modules, checks, mounts, image and lane limit there.
Use one authenticated actor and one private token file per lane slot. Keep credentials outside every mounted directory.

## Execution

Dolber and the planner queue use the same Node.js MCP client. Their queue calls do not start a Python process.
Dolber selects an available implementation Task from the configured Joppa project.
It opens a Herdr tab in the current workspace. Its worker claims that exact Task before preflight or Docker.
A claim refusal stops that worker. An uncertain claim remains reserved until you inspect it.
The continuous dispatcher still checks for other work.

The Task contract must declare exactly one `Repository:` line and one `Module:` line.
These names select entries in the config. Module paths remain inside the selected repository.
The lane reads a snapshot of the claimed Task. Joppa credentials stay on the host.
The snapshot includes the direct parent as acceptance context. The Task contract defines the execution scope.
Completion checks that both authored documents remain unchanged.
The existing lane runs discovery, implementation or verification, configured checks and independent review.

`delivery: "branch"` publishes the checked candidate to `ticket-<execution-id>-<run-id>`. It does not merge or deploy.
`delivery: "target"` lands the candidate on the configured `targetBranch`.
`delivery: "requirement"` keeps one branch for each Requirement and repository.
Tasks use that branch in sequence and merge the current target before implementation.
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
The host confirms the exact remote SHA before it calls `complete_task`.
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

## Failure

Dolber blocks confirmed failures with evidence and releases their claims.
An uncertain claim or outcome stays held until inspection confirms the result.
That worker actor cannot take another Task while its claim remains held.
Unused and unchanged worktrees are removed. Failed worktrees with changes remain for recovery.
A lost completion response requires inspection. Do not rerun code which was already published.
Completion failures also write a Joppa note. Branch delivery uses a separate candidate branch for each retry.

## Config fields

| Field | Purpose |
|---|---|
| `joppa.project` | Select Tasks for one Joppa project address |
| `joppa.workers` | Separate actors and host token files for parallel lanes |
| `joppa.readerTokenFile` | Private read-only token for final Requirement context checks |
| `repositories` | Map contract names to source paths, branches, CBM projects, modules and checks |
| `reviewCommands` | Optional checks before expert review. A repository value overrides the dispatcher value. Defaults to `gateCommands`; full gates run before push |
| `gateTimeoutSeconds` | Maximum seconds per check, default 900. A repository value overrides the dispatcher value |
| `coderTimeoutSeconds` | Optional cap per coder attempt. A repository value overrides the dispatcher value. Omit it to keep the workflow limit |
| `preflight` | Run the configured repository executable in the private checkout, or use `null` |
| `afterLand` | Optional host executable relative to the canonical repository. Run after successful target delivery, before checkout removal |
| `delivery` | `branch`, `target`, or `requirement` |

`sourceRoot` can contain several repositories or be the repository itself.
Only configured repositories enter Git and CBM refresh. No `.ntkrc` is required for Joppa.
`worktreeRoot` sets the checkout directory inside `sourceRoot`. Each Task has a stable execution ID.
The table shows the full Task address, stage or reason code, run ID, start time and duration.
NTK Dolber keeps its existing config and commands.

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
node --input-type=module - /absolute/old/run/launch.json <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {readRun, save, alive} from './lane-launcher/runtime.mjs';
import {api, finishTask} from './lane-launcher/joppa.mjs';
const file = path.resolve(process.argv[2]), run = readRun(file);
if (run.config.source !== 'joppa' || run.config.delivery !== 'branch' || run.finalizeOnly ||
    run.result?.status !== 'failed' || !run.result.finishedAt || alive(run.worker?.pid) ||
    run.completionRequest || run.blockRequest || run.releaseRequest || run.recovery || run.recoveryNoteRequest) {
  throw new Error('Inspect this run before recovery');
}
const lock = path.join(path.dirname(file), 'worker.lock');
fs.mkdirSync(lock);
try {
  for (const claim of run.claim.tasks || [run.claim]) {
    const task = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
    if (task.address !== claim.address || task.process?.status !== 'open' || task.process.assignee !== null) {
      throw new Error('Task release is not confirmed');
    }
  }
  const result = {...run.result};
  await finishTask(run, file, result, null);
  if (!run.releaseConfirmed) throw new Error('Startup release is not confirmed');
  run.result = {...result, released: true, held: false, blocked: false,
    tasks: run.releaseResults, recoveredAt: new Date().toISOString()};
  save(file, run);
  console.log('Release confirmed. Failed result preserved.');
} finally {
  fs.rmdirSync(lock);
}
JS
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
