# Lane

Implement one claimed Joppa Task, review it, and deliver it. The host worker records the Joppa outcome.

## Launch

Dolber reads a local JSON config and starts the host lane worker.
The worker claims the Task, then passes the confirmed receipt, the configured
repository and its settings to `run.sh`. A direct `run.sh` call without that
receipt is refused.

Repeat `--gate-command` for additional checks and `--mount-ro` for additional
read-only repositories. The repository, its `targetBranch` and its optional
`preflight` come from the dispatcher config; there is no branch default.

The whole source workspace and canonical `.git` directories are read-only.
The writable checkout is `<worktreeRoot>/<execution-id>`, mounted at
`/workspace/<execution-id>`, with its own `.git`. Fetch, commits, and landing write
there. Artifacts are writable separately. Existing nonempty checkouts are
retained and rejected on a new launch.

After success, the host removes the private checkout. Reports and logs remain in the run directory.
Failed runs retain code changes. Empty or unchanged checkouts are removed.

Startup uses Crew's `lane-launcher/safe-sync.py` for the configured canonical
repositories under the source root. Up to four repositories refresh in parallel,
each with its own MCP connection. A per-repository `flock` covers fetch,
fast-forward, and shared CBM refresh. Detached HEAD is switched to the configured
branch only when its commit is already in that branch's remote history. Local
changes or divergence stop startup without discarding work. The lock is held
until CBM reports `ready` for that canonical root.
`--dry-run`, `--validate`, and `--graph` only probe the connection.

## Workflow

```sh
medulla -w lane --graph
medulla -w lane --validate
```

Prepare → locate code with CBM → create checkout → implement → check → review
with three agents → synthesize verdicts → land → cleanup. The host worker then
records the outcome in Joppa.
Review blockers return to implementation for up to three rounds. Landing
conflicts go through a fix and another check/review round.

`DUPLICATE` verifies the existing implementation instead of stopping the lane.
The scout lists existing test-file paths in `artifacts/ticket-checks.json`.
Gates execute test paths through the configured `testCommand` argument array.
They also run the ticket's structured acceptance checks. Verification skips configured change gates because it has no change set.
The panel maps all AC to existing code and executed checks.
Passing checks and review complete the Task without a new commit or push. Missing
tests, failed checks, review blockers or a moved target stop with details.
This path never returns to implementation.

The worker claims in the Herdr tab before preflight or Docker. The workflow adopts that receipt
without a second claim. `run.sh` requires that confirmed host receipt before
preflight or Docker; the container never claims. The host worker releases,
blocks or holds the claimed Tasks after the lane ends; see
[dolber-joppa.md](../lane-launcher/dolber-joppa.md). No confirmed claim means no Joppa write.
An uncertain claim or dispatch requires inspection before retrying.
If the repository config declares a preflight, that script must exist and pass before implementation.
A failed declared preflight stops the lane and includes its log in the failure report.

Checks run from the candidate repository before each review. Their commands,
exit codes, tree/SHA, and log hashes are recorded under `artifacts/gates/`.
The coder runs ticket tests. `prepare_review` owns commits and configured checks.
Reviewers read passing results instead of repeating checks on an unchanged tree.
Duplicate configured commands run once. Configure native receipt validation before
an expensive check. Rerun the check when its native receipt is missing or invalid.
Failed checks return to the coder through the existing review repair limit.
Verification-only failures stop without implementation.
Implementation is committed with native hooks before the configured checks and
review. Checks can therefore produce receipts for the exact commit to be pushed.
Landing verifies the checked commit and tree, and runs the native push hook.
Target delivery refreshes and rebases the candidate before the first configured checks.
Set `sharedLockDir` in the dispatcher config, or pass `--shared-lock-dir` to `run.sh`.
The final fetch, rebase, checks and push hold one shared lock per origin and target branch.
A clean rebase runs checks inside that lock without another expert review or workflow loop.
The lock wait is bounded to 3600 seconds. A writer outside this lock can still make the push fail safely.
Conflict resolution or a coder repair requires checks and expert review again.
Force push is unavailable.

After landing, `artifacts/landing.txt` records the landed SHA. The host worker
completes the Task in Joppa with that evidence and never reruns landed work.

Nonblocking findings remain in `artifacts/followups.txt` for the host completion evidence.

## Agent context

Equill supplies contracts and memory. Each agent's `pre` step obtains its role
context; hooks also deliver memory to Claude. Implementation uses
`crew-lane-coder`; the review panel uses `crew-lane-qa`.

Agents implement only the ticket's scope and acceptance criteria. CBM locates
relevant code and checks; findings must be verified against the current source
or checkout. Missing inputs stop the lane with a concrete blocker.

The native host CBM executable is configured through `cbmMcpCommand`. Startup
uses the installed broker's box bridge with `CBM_ALLOWED_ROOT=sourceRoot`
and `CBM_CACHE_DIR=cbmCacheDir`;
expired bridges are recreated. No database copy, extra CBM daemon, or worktree
indexing is created. Startup checks the per-run connector
from the container. Equill is accessed through the host bridge under the fixed
`lane` identity, allowing only `context` and `search`.

The lane reads the Task snapshot from the host claim; Joppa credentials stay on
the host. Shell nodes retain `artifacts/ticket.json` for deterministic checks;
agent prompts use the ticket reader. Codex credentials remain managed by its broker.

The container is the filesystem boundary. The Git key is readable by agents;
prompt restrictions on pushing are not a security boundary.

Private-engine lanes are privileged, as broker boxes are. Read-only source mounts
are not enforced against root inside a privileged container.

## Logs and notifications

Run artifacts include failure details, coder reports, review verdicts, and
landing evidence. The worker displays logs in the ticket's Herdr tab. By default
the tab remains open after completion; `closeTabOnExit` controls closure.

Optional host notifications use `notify.mjs`, with no LLM invocation:

```sh
node notify.mjs config.json READY ticket-id
```

Configure `notify.chatId`, optional `notify.threadId`, and `notify.envFile`
in Dolber JSON, or leave it null. `notify.mjs` sends directly to Telegram and
requires a successful API response. Notification failure is recorded without
changing the lane outcome.

## Verify

```sh
python3 -m unittest discover -s lane/tests -v
```

Tests execute workflow shell nodes with local stubs; they do not select real
Joppa Tasks. The container isolation test is opt-in.
