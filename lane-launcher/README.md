# Lane launcher

## Open the three Joppa actions

Copy `lane-launcher/start.example.json` to a local JSON file.
Set `name` and the configuration path for each action. Paths resolve from that JSON file.

```sh
sh ./lane-launcher/start.sh ./lane-launcher/project.json --dry-run
sh ./lane-launcher/start.sh ./lane-launcher/project.json
```

The command opens `auditor|name`, `dolber|name` and `planner|name` in the current Herdr workspace.
It preserves focus and refuses duplicate tab labels. Each action uses its existing launcher and configuration.
Optional `args` supplies extra arguments for that action. The example keeps the auditor in `--no-publish` mode.
The example starts the auditor immediately and then every 12 hours with `--interval-seconds 43200`.
Audits run in sequence. A failed audit does not stop the schedule. Ctrl+C stops the current audit and the schedule.
Optional `prepare` supplies a command argument array to run once before creating tabs, such as the Broker connector generator.
For a host connector, use Broker 0.9.17 or later with `--target host`. Give JavaScript connectors a `.cjs` extension.
The command uses no shell. A preparation failure leaves all three tabs unopened.
`--dry-run` prints all three commands without creating tabs or starting workflows.

## Run one dispatcher

Run from a Herdr terminal. Requires Node.js 24, Herdr, Docker, Medulla, jq, the installed broker and native CBM on the host, plus the Crew image.
Joppa is the only ticket source. [dolber-joppa.md](dolber-joppa.md) describes Task selection, delivery modes and the Joppa config fields.

```bash
cp -n lane-launcher/dolber-joppa.example.json lane-launcher/project.json
# Edit lane-launcher/project.json, then run:
./lane-launcher/dolber-joppa.sh lane-launcher/project.json --dry-run
./lane-launcher/dolber-joppa.sh lane-launcher/project.json
```

Pass a JSON configuration file as the first argument; relative paths resolve from
the current directory. `--config <file>` is equivalent. Without a file argument,
`dolber-joppa.sh` reads **`dolber-joppa.json` beside the script**, regardless of the current
directory. Settings are loaded once at startup; restart after editing them.

Set `id` in the selected JSON config. Use a stable ID per dispatcher, for example `project-backend` and `project-app`; retain it across restarts. Each ID has its own lane limit, lock and reservations. Each individual launch still has a fresh UUID. Moving the terminal does not change dispatcher identity.

Local JSON configs directly under `lane-launcher/` are ignored by Git, including
their `workspace` settings. Only `*.example.json` templates belong in the repository.

| Setting | Meaning |
| --- | --- |
| `id` | Required stable dispatcher ID, set only in the config. Case-insensitive, normalized to lowercase. 1–64 letters, digits, dots, underscores or hyphens, starting with a letter/digit |
| `workspace` | Joppa workspace of the configured project |
| `limit`, `intervalSeconds` | Maximum active lanes and polling interval; defaults are 1 and 60 seconds |
| `launchLanes` | **Defaults to false:** show the selected Task without launching a lane or creating a Herdr tab |
| `closeTabOnExit` | **Defaults to false:** keep the tab open after completion for inspection; set true to close it automatically |
| `sshDir` | Absolute path to the Git key directory |
| `sourceRoot` | Absolute path to the entire source workspace, mounted read-only |
| `cbmMcpCommand` | Absolute path to the native host CBM executable. Broker creates a current bridge scoped to `sourceRoot` at each lane start; do not use a temporary box shim |
| `cbmCacheDir` | Absolute path to the existing shared CBM store, matching the active CBM daemon. No store is created or copied |
| `readOnlyRepos` | Additional repositories mounted read-only |
| `readWriteDirs` | Existing absolute directories mounted writable at `/workspace/<directory-name>`; defaults to `[]` |
| `sharedLockDir` | Required for target and requirement delivery: one existing shared directory directly under `sourceRoot`, mounted writable at `/workspace/<directory-name>` |
| `image` | Lane runtime image; defaults to `medulla-crew:latest` |
| `dockerEngine` | Enable private Docker inside the lane for integration tests; defaults to `false` |

The entire `sourceRoot`, including canonical Git metadata, is read-only.
The Task names its configured repository; there is no repository override.
Only `<worktreeRoot>/<execution-id>` is mounted writable for code and Git
metadata. It is an independent checkout with its own `.git`. Run artifacts and configured `readWriteDirs` are writable separately.
A retained nonempty checkout is preserved and startup fails.

For a shared Gradle cache, set `"readWriteDirs": ["/absolute/path/gradle-cache"]`.
For a shared tooling lock, set `sharedLockDir` to its existing parent directory under `sourceRoot`.
That directory holds the lock and its queue. Repository, key and CBM directories remain protected.
Create that directory before launch. Set `GRADLE_USER_HOME=/workspace/gradle-cache` in the project's check command.
Writable directories must not overlap the source workspace, read-only folders, SSH directory or CBM store.
Their directory names must be unique across mounts and must differ from the ticket ID.

In preview mode (`launchLanes: false`), Dolber reads the available Tasks of the configured project but never claims a Task, creates a tab or starts a lane. Herdr uses the current terminal's workspace automatically. Advanced overrides `herdrWorkspace`, `herdr` and `stateDir` may also be set in the JSON.

Preview output has this shape (the address below is an example):

```text
Running lanes 0 of 1
Joppa Tasks [workspace=example, project=project:app]: 2 available · 0 held workers
checking params:
  project: project:app
Starting new one with ticket: task:example (preview: запуск отключён)
```

The selected Task address is bold cyan, followed by its title in yellow without bold. The lane count is bold green while capacity is available, and bold yellow when the limit is full. One cyan horizontal line starts each iteration. Labels, filters, preview and pause use normal terminal brightness; no text is dimmed. Errors are red. Redirected logs remain plain text. Set `FORCE_COLOR=1` to force color or `NO_COLOR=1` to disable it.

The dispatcher waits 60 seconds after each iteration and continues until Ctrl+C, with a default limit of one lane. With actual launches enabled, it opens a tab and starts the lane worker there. The worker claims the selected Task in Joppa before preflight or Docker. The container workflow adopts that confirmed receipt without claiming again. A preview does not claim work. Each tick starts at most one lane.

In a terminal, the loop shows a live table of the latest 30 lane runs.
Each row shows the start date, ticket ID, status, Medulla stage, run ID, and duration.
The start date uses `YYYY-MM-DD HH:mm:ss` in the local time zone. Duration uses `HH:MM:SS`.
`RUN ID` shows the full launch directory UUID.
Find its log at `<stateDir>/crew-dispatchers/<id>/runs/<RUN-ID>/output.log`.
Active rows show the stage from the existing Medulla journal. Failed rows show the reason from the failure report or result.
`READY` rows are bright green and show no stage. They mean that the lane completed successfully for testing.
`BLOCKED` is yellow. Failures and lost workers are red. `RUNNING` and `STARTING` are blue.
Active rows show elapsed time. Finished rows show total time.
Other finished rows use softer white text for the ticket ID, reason, and time.
Reasons omit absolute file paths.

The table and countdown update every five seconds without adding scrollback lines.
Dispatcher errors remain in the normal terminal scrollback with their full text and a timestamp.
Small terminal windows show fewer rows. Long rows wrap without shortening IDs. The full run history remains on disk.
Ctrl+C restores the terminal and leaves one final table.

`--once`, `--dry-run`, and redirected output keep the existing text output.
Each new run keeps its input, worker PID, start time, and result in `launch.json`.
The display reads that file. It does not create a separate history store.
Existing runs can still use their earlier `worker.json` and `result.json` files.

A refused or unconfirmed claim fails visibly in the tab, without starting preflight or Docker. Dolber continues polling. `CLAIM_REFUSED` means Joppa refused the claim or returned no confirmation. Any other claim error produces `CLAIM_UNCERTAIN`: inspect the Task in Joppa before retrying. [dolber-joppa.md](dolber-joppa.md) describes how the worker releases, blocks or holds claimed Tasks.

Each lane opens in a separate tab in the current Herdr workspace without stealing focus. For testing, `closeTabOnExit: false` keeps the tab open after success or failure so its logs remain visible. A finished lane frees capacity even while its tab stays open. Set `closeTabOnExit: true` to close its pane automatically on exit. The tab contains only that pane. Logs and results remain in `~/.medulla/lane-launcher/crew-dispatchers/<id>/runs/<run-id>/`; a process exit code is not proof of successful landing — inspect the lane artifacts for its outcome. Ctrl+C in the dispatcher stops polling; existing lanes continue.

The current terminal's `HERDR_WORKSPACE_ID` takes precedence over a configured workspace override. Herdr creates the tab and runs `worker.mjs` in its pane; the worker runs the existing `lane/run.sh`, whose workflow selects the Equill Medulla roles. Live output appears in that tab: cyan marks stage starts, yellow marks stage transitions and startup messages, green marks successful terminal transitions, and red marks failed terminal transitions. Existing engine colors are preserved. `output.log` keeps the original lane output, without added display colors.

Use `--dry-run` for one preview iteration: check configuration, then show the selected Task. This flag overrides `launchLanes: true` without editing the configuration; it never claims a Task, changes Joppa, opens a Herdr tab or starts a lane. It requires only the preview settings and tools. Use `--once` for one iteration respecting `launchLanes` in the configuration. Without either flag, the dispatcher loops until Ctrl+C.

Capacity includes only Docker lane containers and pending reservations belonging to the selected dispatcher ID. Container membership uses the existing `medulla.workflow=lane` and `medulla.runs_under` labels: the run path contains `crew-dispatchers/<id>/`. Other IDs, other workflows and legacy containers without a dispatcher identity are excluded. Stop or finish old unscoped lanes before switching their dispatcher to this version; their historical files are retained. Docker/Herdr inspection errors prevent launches. Use the same `stateDir` for all dispatcher invocations: locks are under `crew-dispatchers/<id>/dispatcher.lock`, so the same ID cannot run twice while different IDs can run concurrently. Manual `lane/run.sh` launches require `--dispatcher-id <id>` and become visible to that dispatcher through their container label. Manual launches must respect the same limit; a separate manual start can race the dispatcher. After a hard crash, inspect `dispatcher.lock/owner.json` and remove the lock only once that PID has stopped. An uncertain tab creation keeps its reservation until inspected; it does not silently free capacity.

## Joppa execution

Set `joppa.mcpCommand` to the host connector generated by `broker box connect` for the existing Joppa login.
Set `joppa.workers` to one entry with that existing user's `actor`. Do not create separate worker identities or tokens.
The user can hold several independent Tasks. The lane limit and Requirement occupancy still bound dispatch.
Shared-login mode supports `target` and `branch` delivery. `requirement` delivery still requires the legacy reader configuration.
Existing configurations without `mcpCommand` retain separate worker token behavior.

Each dispatcher writes only to its configured Joppa workspace.
The planner can read accessible linked contracts in other workspaces through the existing login.
Foreign objects use an immutable workspace ID and a full object address. Their schemas remain separate.
Blocking remote links must have a current revision pin and an accessible, present, satisfied target without pending review.
The worker checks these conditions before startup and again before push. Joppa also checks them when it records completion.
These checks require `joppa.mcpCommand` or `joppa.readerTokenFile` inside the lane.
Native MCP uses one Broker connector file per run. The host login stays on the host.
Remote link creation and revision changes remain explicit specification edits. Local Task saves preserve existing remote links.
A child workspace status is a display summary. It does not prove the parent AC passed.

`dolber-joppa.sh` passes `--source joppa`; `launcher.mjs` accepts it for compatibility.
The dispatcher selects one executable Task per lane.
Task title prefixes such as `[01]` and `[02]` break selection ties within one Requirement and repository.
Blocking dependencies control eligibility, including dependencies within the same Requirement and repository.
One lane uses one coder session, checkout, gate cycle, expert review, and landing for that Task.

Before upgrading a dispatcher that used grouped runs, pause admission and audit its unclaimed Tasks.
Each Task must land independently. Replan coupled Tasks or exclude them through the existing Joppa review state.
Preserve active worker and planner claims. Resume only after every selectable Task passes this audit.

The worker claims the selected Task before Docker starts. New runs cannot claim multiple Tasks.
Existing package claims retain their original completion and release rules.
Each Task keeps its contract, writable roots, revision, and acceptance context.
Completion checks the Task and acceptance context against the confirmed landing evidence.

`launch.json` stores the ordered `tasks`, the Requirement address, and the saved atomic requests.
The result maps each Task address to its confirmed status and revision in `result.tasks`.
A confirmed workflow failure blocks all held Tasks atomically.
An uncertain claim, worker state, or outcome retains the Tasks for inspection.

A single Task can return to the queue after an `implement_code` timeout before any landing attempt.
The worker requires a stopped session container and a clean checkpoint with new changes inside the Task scope.
It verifies the remote recovery ref, saves a typed Joppa note, and moves the checkout before releasing the Task.
It deletes the moved checkout only after Joppa confirms the release.
The next claim checks the Task and acceptance context, then restores the exact checkpoint before coding.
The coder completes the remaining work. Normal checks, expert review, and landing still apply.
Changed context, missing remote evidence, or an uncertain release requires inspection. The worker does not restart from an empty checkout.
This recovery does not apply after landing starts, during expert review, or after a workflow deadline.

## Ticket tests

For `DUPLICATE` verification, configure `testCommand` as runner arguments,
for example `["bun", "run", "test"]`. Scout supplies existing test-file paths;
it cannot replace the configured runner with arbitrary shell commands.
The launcher rejects an empty runner before selecting or claiming a Task.

## Notifications

`notify.mjs` sends completion events directly through the Telegram Bot API.
Set `notify.chatId` and optional `notify.threadId` in the local dispatcher config.
Supply `TELEGRAM_BOT_TOKEN` in the environment, or point `notify.envFile` at an
existing local env file containing that variable. Keep credentials out of Git.
Replace legacy `notify.to`, `notify.room` and `notify.from` with these fields.
Messages show a bold status, a green or red dot, and a bold ticket ID.
For failures, `Reason:` contains only the reason code. Detailed explanations stay in Joppa notes and the logs.
Messages omit the run ID and absolute file paths.
Both IDs use code formatting for copying.
No log files or exit-code/log-path metadata are sent to Telegram. Full logs remain
in the run directory. No agent rewrites the message.
Delivery failures are recorded without changing
the ticket outcome.

```bash
node --test lane-launcher/test/*.test.mjs
python3 -m unittest discover -s lane/tests
```
