# Crew

Medulla workflows for preparing and implementing tickets.

## Workflows

- [Planning](planning/README.md): prepare one acceptance criterion, resolve questions,
  and produce scoped tasks with implementation instructions and checks.
- [NTK planning](planning-ntk/README.md): prepare one ticket or re-plan a blocked Lane failure.
- [Lane](lane/README.md): implement one prepared NTK ticket, check it, review it,
  land it, and set `to_test`. A workflow failure sets `blocked` with a report.
- [Dolber](lane-launcher/README.md): select open tickets and launch lanes within
  the configured dispatcher limit.

## Configuration

Pass a local JSON file to Dolber. Start from
[lane-launcher/dolber.example.json](lane-launcher/dolber.example.json).
Local configuration files are ignored by Git.

```sh
sh lane-launcher/dolber.sh /path/to/config.json --dry-run
sh lane-launcher/dolber.sh /path/to/config.json --once
```

`--dry-run` previews one selection without claiming or opening a tab.
`--once` starts at most one lane when `launchLanes` is true. Without either flag,
Dolber repeats at the configured interval until Ctrl+C.

The config supplies the NTK workspace, tags, preferred tags, source root,
shared CBM connector, Git key directory, checks, dispatcher ID, and lane limit.
The ticket module identifies its repository under the source root.
Each repository must explicitly set `target_branch` in `.ntkrc`.

## Runtime

The entire source root is read-only. Each ticket has a writable private checkout
at `<source-root>/.worktrees/<ticket>` with its own `.git`. Run artifacts are
stored separately. Retained work is never reset by a new launch.

All lanes access shared host CBM storage through the configured connector. Crew
does not copy databases, start CBM daemons, or index worktrees. Equill supplies
role contracts and memory.
`roles/*.jsonl` are recovery snapshots; the live Equill store is authoritative.
Lane and planning snapshots cover their six roles; the shared snapshot contains
the common rules included in their contracts.
Do not import a stale snapshot over that store.

Enable the Crew pre-push hook in each checkout:

```sh
git config core.hooksPath .githooks
```

Before each push it exports these six live contracts and their shared rules.
If snapshots change, the push stops: commit `roles/*.jsonl` and push again.
An Equill error also stops the push. The store defaults to `~/.equill/dev`;
override it with `EQUILL_STORE`. Run `python3 roles/export.py` to export manually.

The worker atomically claims a ticket in its Herdr tab before preflight or Docker. Startup failure
returns the confirmed claim to `open`. Once the workflow adopts the claim,
failure sets `blocked` and attaches details. An unconfirmed claim changes no
status. An uncertain dispatch keeps its reservation for inspection.

Landing uses native repository hooks and a normal push. It refuses dirty work,
failed checks, an unreviewed tree, or a target ahead of the candidate. Setting
`to_test` is retried up to three times. A status failure after landing preserves
its SHA and does not rerun implementation or set the landed ticket to `blocked`.

Each nonblocking review finding creates a `[FINIDING] <summary>` ticket:
`blocked`, dependent on the source, with all source tags plus `findings` and
an attached report. It does not trigger another implementation round.

## Build and checks

```sh
broker box build
docker build --build-arg USER_UID=$(id -u) -t medulla-crew:latest .
medulla -w lane --validate
node --test lane-launcher/test/*.test.mjs
python3 -m unittest discover -s lane/tests -v
```

The image extends `broker-box` with Medulla and repository check tools.
Each lane uses the broker's on-demand private Docker engine for integration tests.
Its Docker storage is removed with the lane container. No host Docker socket is mounted.
Host Medulla, Docker, Equill, Git credentials, and the shared CBM connector
must be available. Startup runs `lane-launcher/safe-sync.py`: each immediate
canonical repository with `.ntkrc` is locked, fetched, fast-forwarded to its
configured branch, and reindexed through the shared CBM connector. Up to four
repositories refresh in parallel with separate MCP connections. Each repository
lock is held until CBM reports ready for that canonical root.
Dirty or diverged sources stop startup. Dry runs do not refresh sources or CBM.
