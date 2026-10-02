# Lane launcher

Run from a Herdr terminal. Requires Node.js 24, Herdr, Docker, Medulla and jq on the host, plus the Crew image. The lane invokes the status script by its path inside the mounted Crew checkout, so it does not require a globally installed `ntk-status` or an image rebuild just to obtain this script.

```bash
cp -n lane-launcher/dolber.example.json lane-launcher/project.json
# Edit lane-launcher/project.json, then run:
./lane-launcher/dolber.sh lane-launcher/project.json --dry-run
./lane-launcher/dolber.sh lane-launcher/project.json
```

Pass a JSON configuration file as the first argument; relative paths resolve from
the current directory. `--config <file>` is equivalent. Without a file argument,
`dolber.sh` reads **`dolber.json` beside the script**, regardless of the current
directory. Settings are loaded once at startup; restart after editing them.

Set `id` in the selected JSON config. Use a stable ID per dispatcher, for example `project-backend` and `project-app`; retain it across restarts. Each ID has its own lane limit, lock and reservations. Each individual launch still has a fresh UUID. Changing tags or moving the terminal does not change dispatcher identity.

Local JSON configs directly under `lane-launcher/` are ignored by Git, including
their `workspace` settings. Only `*.example.json` templates belong in the repository.

| Setting | Meaning |
| --- | --- |
| `id` | Required stable dispatcher ID, set only in the config. Case-insensitive, normalized to lowercase. 1–64 letters, digits, dots, underscores or hyphens, starting with a letter/digit |
| `workspace`, `project` | NTK workspace and project to search |
| `tags` | Tag filters, for example `["crew", "backend"]`; `[]` means no tag filter |
| `strict` | `false` matches tag substrings case-insensitively; `true` requires exact tags. All tag filters are required in either mode |
| `preferTags` | Tags in priority order, separate from filtering |
| `module`, `assignee` | Optional NTK filters; `null` omits the filter |
| `limit`, `intervalSeconds` | Maximum active lanes and polling interval; defaults are 1 and 60 seconds |
| `launchLanes` | **Defaults to false:** show the selected ticket without launching a lane or creating a Herdr tab |
| `closeTabOnExit` | **Defaults to false:** keep the tab open after completion for inspection; set true to close it automatically |
| `sshDir` | Absolute path to the Git key directory |
| `sourceRoot` | Required for launches: absolute path to the entire source workspace, mounted read-only |
| `cbmMcpCommand` | Absolute path to an existing Python stdio connector to the shared host CBM service; for example, the connector already used by a workspace box |
| `readOnlyRepos` | Additional repositories mounted read-only |
| `gateCommands` | Required check commands run against the lane's candidate |
| `image` | Lane runtime image; defaults to `medulla-crew:latest` |
| `dockerEngine` | Enable private Docker inside the lane for integration tests; defaults to `false` |

The entire `sourceRoot`, including canonical Git metadata, is read-only.
The first component of the ticket's NTK module names its source repository
under `sourceRoot`; there is no project lookup table or repository override.
Only `<sourceRoot>/.worktrees/<ticket>` is mounted writable for code and Git
metadata. It is an independent checkout with its own `.git`, exposed inside the
container at `/workspace/<ticket>`. Run artifacts are writable separately.
A retained nonempty checkout is preserved; startup fails and reopens the confirmed claim.

The supplied file uses required tag filter `agent-ready`, `strict: false`, preferred tags `bug`, `kyc`, `ceo60`, `kyt`, and a 60-second pause between iterations. NTK independently requires the ticket's status to be `open`; do not add `open` as a tag to express this status. Preferred tags match exactly, including case, and affect ordering after NTK urgency and dependency ranking.

The supplied file leaves workspace, local paths and checks empty. In preview mode (`launchLanes: false`), only id, workspace, NTK authentication and Docker are required. Ticket selection spans all projects in that workspace. Preview does not need Herdr, Medulla, repository paths or gate commands. Fill in the workspace, sourceRoot, paths and checks before enabling actual launches. Herdr then uses the current terminal's workspace automatically. Advanced overrides `herdrWorkspace`, `herdr` and `stateDir` may also be set in the JSON. Credentials remain in the NTK credentials file or environment.

Preview output has this shape (the ID below is an example):

```text
Running lanes 0 of 1
Tickets with tags [workspace=example, tags=agent-ready, strict=false]: 56 total · 17 open · ready to work: ≥1
checking params:
  tags: agent-ready
  prefer: bug → kyc → ceo60 → kyt
Запускаю lane на тикет id: EXAMPLE-ID (preview: запуск отключён)
```

Each tick counts all tickets and open tickets matching the workspace, tags and strict setting via NTK's count endpoint, including when all lane slots are occupied. Open tickets can still have unmet dependencies or no module; this count does not mean they can all be dispatched. If counting fails, selection continues and the count reads `unavailable`.

Preview uses `next?dry_run=true` and read-only ticket counts. It never claims or updates a ticket, creates a tab, or starts a lane. A null preview means `ready to work: 0`; any remaining open tickets are marked `(blocked)` by dispatch conditions. A returned candidate means `ready to work: ≥1`: next returns one ticket, not a queue count. At the lane limit, readiness reads `not checked (lane limit)` and no preview is requested.

The selected ticket ID is bold cyan, followed by its title in yellow without bold. The lane count is bold green while capacity is available, and bold yellow when the limit is full. One cyan horizontal line starts each iteration. Labels, filters, preview and pause use normal terminal brightness; no text is dimmed. Errors are red. Redirected logs remain plain text. Set `FORCE_COLOR=1` to force color or `NO_COLOR=1` to disable it.

The dispatcher waits 60 seconds after each iteration and continues until Ctrl+C, with a default limit of one lane. JavaScript calls `POST /v1/tickets/next?dry_run=true` to preview an **open** ticket matching the configured filters, with a module and satisfied dependencies. With actual launches enabled, the dispatcher atomically claims it through `POST /v1/tickets/<id>/start` before opening a tab. The lane adopts that confirmed receipt without claiming again. A preview does not claim work. Each tick starts at most one lane.

In a terminal, the pause is a single updating line: `Next check in 00:59 · Ctrl+C to stop`, with the remaining time in bold cyan. Redirected output keeps a single static `pause 60s` line. Ctrl+C clears the countdown and stops waiting immediately.

A refused claim opens no tab and changes no ticket status. A confirmed startup failure returns an `in_progress` ticket to `open`. After the workflow adopts the claim, its failures produce `blocked` with a report. An uncertain worker launch retains the claim and reservation for inspection.

Failure handling requires a confirmed claim receipt for this ticket, workspace and run. Without it, the lane fails without changing NTK. After a confirmed claim, failure handling attaches a report with the available LLM explanations and check evidence to the blocked ticket. After landing, the internal completion helper tries `to_test` at most three times with a one-second pause between attempts. If all attempts fail, the lane exits with an error and preserves the landed SHA in `artifacts/landing.txt`; recover the ticket status without rerunning implementation.

NTK requires `force: true` for `in_progress → blocked`; failure handling uses it for `blocked`, and confirmed startup recovery uses it for `open`. Normal `to_test` updates omit force. A blocked ticket stays out of the queue until an operator investigates the saved failure, fixes the cause, and explicitly reopens it. To retry after that review, run `./lane-launcher/ntk-status TICKET_ID -W WORKSPACE -s open --force`. This is manual recovery for blocked work; startup recovery only reopens a confirmed claim before the workflow adopts it.

Each lane opens in a separate tab in the current Herdr workspace without stealing focus. For testing, `closeTabOnExit: false` keeps the tab open after success or failure so its logs remain visible. A finished lane frees capacity even while its tab stays open. Set `closeTabOnExit: true` to close its pane automatically on exit. The tab contains only that pane. Logs and results remain in `~/.medulla/lane-launcher/crew-dispatchers/<id>/runs/<run-id>/`; a process exit code is not proof of successful landing — inspect the lane artifacts for its outcome. Ctrl+C in the dispatcher stops polling; existing lanes continue.

The current terminal's `HERDR_WORKSPACE_ID` takes precedence over a configured workspace override. Herdr creates the tab and runs `worker.mjs` in its pane; the worker runs the existing `lane/run.sh`, whose workflow selects the Equill Medulla roles. Live output appears in that tab: cyan marks stage starts, yellow marks stage transitions and startup messages, green marks successful terminal transitions, and red marks failed terminal transitions. Existing engine colors are preserved. `output.log` keeps the original lane output, without added display colors.

Use `--dry-run` for one preview iteration: check configuration and Docker, then show the selected ticket if capacity is available. This flag overrides `launchLanes: true` without editing the configuration; it never claims a ticket, changes NTK, opens a Herdr tab or starts a lane. It requires only the preview settings and tools. Use `--once` for one iteration respecting `launchLanes` in the configuration. Without either flag, the dispatcher loops until Ctrl+C.

If a startup failure reopens a ticket, or reopening fails, the dispatcher stops before its next queue read, releases its lock and reports the run directory. Fix startup and restart Dolber manually. Completed startup failures from before that invocation do not prevent a restart. Blocked tickets and refused claims do not trigger this stop.

Capacity includes only Docker lane containers and pending reservations belonging to the selected dispatcher ID. Container membership uses the existing `medulla.workflow=lane` and `medulla.runs_under` labels: the run path contains `crew-dispatchers/<id>/`. Other IDs, other workflows and legacy containers without a dispatcher identity are excluded. Stop or finish old unscoped lanes before switching their dispatcher to this version; their historical files are retained. Docker/Herdr inspection errors prevent launches. Use the same `stateDir` for all dispatcher invocations: locks are under `crew-dispatchers/<id>/dispatcher.lock`, so the same ID cannot run twice while different IDs can run concurrently. Manual `lane/run.sh` launches require `--dispatcher-id <id>` and become visible to that dispatcher through their container label. Manual launches must respect the same limit; a separate manual start can race the dispatcher. After a hard crash, inspect `dispatcher.lock/owner.json` and remove the lock only once that PID has stopped. An uncertain tab creation keeps its reservation until inspected; it does not silently free capacity.

## Status-only CLI

```bash
./lane-launcher/ntk-status TICKET_ID -W WORKSPACE -s to_test
./lane-launcher/ntk-status TICKET_ID -W WORKSPACE -s blocked --force
./lane-launcher/ntk-status TICKET_ID -W WORKSPACE -s in_progress --claim
```

The CLI only changes status: `PATCH /v1/tickets/<id>` with `workspace`, `status` and optional explicit `force`. `--claim` is the atomic transition to `in_progress`: it uses the dedicated start endpoint and fails when another lane already owns the ticket or dependencies are unfinished. It cannot be combined with `--force`. Setting `in_progress` without `--claim` is rejected before a request: PATCH does not enforce the server's dependency guard. The lane's normal transition to `to_test` does not use force. The CLI prints JSON, exits nonzero on failure and never retries writes. Queue reads use the internal HTTP library. These scripts do not use MCP; agent MCP tools remain available inside the lane.

Authentication uses `~/.config/ntk/config.json` (`url`, `key`) or `NTK_CONFIG`, `NTK_KEY`, `NTK_URL`. Requests go directly to the existing HTTP API over HTTPS. Medulla mounts the default NTK config directory into the lane container; an environment-only key or custom config path must also be made available inside the container. Keep credentials out of launcher config and workflow variables.

```bash
node --test lane-launcher/test/*.test.mjs
python3 -m unittest discover -s lane/tests
```
