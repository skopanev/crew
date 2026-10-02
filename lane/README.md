# Lane

Implement one prepared NTK ticket, review it, land it, and set `to_test`.

## Launch

Dolber reads a local JSON config and starts the host lane worker.
The worker claims the ticket, then passes the confirmed receipt and config
settings to `run.sh`. A direct `run.sh` call without that receipt is refused.

Repeat `--gate-command` for additional checks and `--mount-ro` for additional
read-only repositories. The repository comes from the first component of the
ticket module. Its `.ntkrc.target_branch` is required; there is no branch default.

The whole source workspace and canonical `.git` directories are read-only.
The writable checkout is `<source-workspace>/.worktrees/<ticket>`, mounted at
`/workspace/<ticket>`, with its own `.git`. Fetch, commits, and landing write
there. Artifacts are writable separately. Existing nonempty checkouts are
retained and rejected on a new launch.

Startup uses Crew's `lane-launcher/safe-sync.py` for canonical repositories under
the source root that have `.ntkrc`. Up to four repositories refresh in parallel,
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
with three agents → synthesize verdicts → land → cleanup → update status.
Review blockers return to implementation for up to three rounds. Landing
conflicts go through a fix and another check/review round.

`DUPLICATE` verifies the existing implementation instead of stopping the lane.
The scout lists existing test-file paths in `artifacts/ticket-checks.json`.
Gates execute them through the configured `testCommand` argument array, plus
configured checks. The panel maps all AC to existing code and executed tests.
Passing checks and review set `to_test` without a new commit or push. Missing
tests, failed checks, review blockers or a moved target stop with details.
This path never returns to implementation.

The worker claims in the Herdr tab before preflight or Docker. The workflow adopts that receipt
without a second claim. `run.sh` requires that confirmed host receipt before
preflight or Docker; the container never claims. Startup failure
returns a dispatcher claim to `open`. After adoption, workflow failure sets
`blocked` and attaches the failure report. No confirmed claim means no status write.
An uncertain claim or dispatch requires inspection before retrying.

Checks run from the candidate repository before each review. Their commands,
exit codes, tree/SHA, and log hashes are recorded under `artifacts/gates/`.
Landing requires the checked and reviewed tree and runs native Git hooks.
A moved target requires a rebase and another review; force push is unavailable.

After landing, `to_test` has three attempts with one-second pauses. Exhaustion
fails the run and preserves `artifacts/landing.txt` and `to-test-errors.txt`.
It does not reimplement or block an already landed ticket.

Each nonblocking finding creates a `[FINIDING] <summary>` ticket in the same
project/module, initially `blocked`, dependent on the source. It inherits all
source tags plus `findings`; `finding-report.txt` carries the evidence. There
is no count limit. Saved creation receipts prevent recreating a confirmed
finding on an attachment retry. Finding publication failures leave the source
in `to_test`.

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

NTK reads, claim, status updates, and attachments use HTTP. Shell nodes retain
`artifacts/ticket.json` for deterministic checks; agent prompts use the ticket
reader. Codex credentials remain managed by its broker.

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
node notify.mjs config.json READY ticket-id "Ticket ready for test"
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
queue tickets. The container isolation test is opt-in.
