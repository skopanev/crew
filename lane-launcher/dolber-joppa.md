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
The host confirms the exact remote SHA before it calls `complete_task`.
For target delivery, it also accepts the checked SHA as an ancestor of the current target.
Joppa `done` records execution. It does not accept the AC or Requirement.

## Failure

The deployed Joppa API has no failed or blocked Task transition.
Dolber records a failure note and retains the confirmed claim. It does not release failed work into an immediate retry loop.
That worker actor cannot take another Task until its claim is resolved.
Unused and unchanged worktrees are removed. Failed worktrees with changes remain for recovery.
A lost completion response requires inspection. Do not rerun code which was already published.
Completion failures also write a Joppa note. Each retry uses a separate candidate branch.

## Config fields

| Field | Purpose |
|---|---|
| `joppa.project` | Select Tasks for one Joppa project address |
| `joppa.workers` | Separate actors and host token files for parallel lanes |
| `repositories` | Map contract names to source paths, branches, CBM projects, modules and checks |
| `reviewCommands` | Optional checks before expert review. A repository value overrides the dispatcher value. Defaults to `gateCommands`; full gates run before push |
| `gateTimeoutSeconds` | Maximum seconds per check, default 900. A repository value overrides the dispatcher value |
| `preflight` | Run the configured repository executable in the private checkout, or use `null` |
| `afterLand` | Optional host executable relative to the canonical repository. Run after successful target delivery, before checkout removal |
| `delivery` | Publish a candidate branch, or land on the configured target |

`sourceRoot` can contain several repositories or be the repository itself.
Only configured repositories enter Git and CBM refresh. No `.ntkrc` is required for Joppa.
`worktreeRoot` sets the checkout directory inside `sourceRoot`. Each Task has a stable execution ID.
The table shows the full Task address, stage or reason code, run ID, start time and duration.
NTK Dolber keeps its existing config and commands.

Expert review uses the receipt for `reviewCommands`. Landing replaces
`artifacts/gates/current.json` with the full gate receipt before push.
Earlier receipts remain in their existing directories.

`afterLand` receives four arguments: checkout path, landed SHA, target branch, and the target SHA before this push.
The fourth argument defines the complete delivered change range, including all Task commits after rebase.
Older workers supply only three arguments. A hook that needs the range must reject a missing fourth argument.
Crew uses the hook version in the canonical checkout when the lane ends.
Its working directory is the checkout. It has 120 seconds, followed by a five-second stop limit.
It must use existing check results. It must not change HEAD or source files.
Crew checks HEAD and Git status afterward. A failed hook retains the checkout and records `POST_LAND_FAILED`
in the run result, table and notification. The log and result include the retry command.
Confirmed Task completion remains valid. A completed Task's retained checkout does not occupy its Requirement group.
Branch delivery and verification without a push do not run this hook.
