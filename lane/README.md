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

Joppa supplies role contracts and memory through the configured Read API.
The launch config maps scout, coder, reviewer and gitfix roles to their process names. The optional QA key remains accepted for compatibility.
Add `context.roles.reviewer` and `context.roles.gitfix` to existing launch configs before a real run.
Scout and reviewers read one prepared contract file. Their SessionStart hook skips duplicate delivery.
Coder and gitfix read their contracts through SessionStart.
Prompt and tool hooks read lessons through the same API. A lesson revision is delivered once per agent session.
Set `context.query.filter.role` to the configured lesson group, such as `lane`. Omit `context.query` to disable retrieval.
The Stop hook reads its configured ending field and returns that text unchanged.

Set `hooks` to an absolute project settings JSON path to replace the bundled hook events.
Crew copies the file into a private read-only mount. Claude and Codex use the same configured events.
The default permissions and environment remain. Custom commands stay unchanged, except for `<TOOLING_ROOT>` expansion.
Commands must resolve inside the container. Include the context-loader events when using a custom file.

AGY reads its hooks from `$HOME/.gemini/config/hooks.json` in the private container home.
`agy-home.sh` runs only under `medulla --docker` as a non-root user, so a host run writes nothing.
It writes that file only when the selected settings run Crew's `lane/hooks/memory-hook.sh` at PreToolUse.
AGY tool hooks cannot add context. PreToolUse records the last 10 calls of the conversation.
The next PreInvocation runs one memory query for them and gives the lessons as an ephemeral message.
Stop removes the record. Other custom commands are not translated for AGY.
The lane requires AGY. A missing AGY token is prepared once with `broker-agy` in the same home.
When that fails, startup stops with `AGY_AUTH_UNAVAILABLE` before the coder starts.

Set `workflow` to an absolute project `workflow.yaml` path to replace `lane/workflow.yaml`.
Dolber runs `medulla -w <file> --validate` before it reads or claims a Task.
Medulla mounts the directory of that file read-only at `/mnt/medulla-workflows/<directory-name>` and reads `workflow.yaml` there.
Medulla also reads a `.env` file in that directory. Keep only workflow files in it.
Crew stays read-only at `/workspace`, and `TOOLING_ROOT` is `/workspace`. Crew scripts keep their `${TOOLING_ROOT}/lane/` paths.
The Docker label `medulla.workflow` shows the directory name instead of `lane`.

Each Task snapshot includes its parent AC's live `acceptanceTests`, with title, body and command when present.
Authored `checks` and `acceptance_checks` are optional. Without acceptance rows, Crew creates no test bindings.
The project test uploader can record its report names directly. Existing acceptance rows retain their binding checks.

Agents implement only the ticket's scope and acceptance criteria. CBM locates
relevant code and checks; findings must be verified against the current source
or checkout. Missing inputs stop the lane with a concrete blocker.

The native host CBM executable is configured through `cbmMcpCommand`. Startup
uses the installed broker's box bridge with `CBM_ALLOWED_ROOT=sourceRoot`
and `CBM_CACHE_DIR=cbmCacheDir`;
expired bridges are recreated. No database copy, extra CBM daemon, or worktree
indexing is created. Startup checks the per-run connector
from the container. Context uses curl and jq, with a workspace Read key in a private read-only mount.

The lane reads the Task snapshot from the host claim; Joppa credentials stay on
the host. Only the scoped context Read key enters the lane. Shell nodes retain `artifacts/ticket.json` for deterministic checks;
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
