# Crew

Medulla workflows for planning Joppa Tasks, implementing them and auditing code against the specification.

## Workflows

- [Joppa planning](planning-joppa/README.md): plan one acceptance criterion or Requirement
  and publish scoped Joppa Tasks. [planning](planning/README.md) holds its shared graph.
- [Lane](lane/README.md): implement one claimed Joppa Task, check it, review it and
  deliver it. The host worker records the outcome in Joppa.
- [Dolber](lane-launcher/README.md): select available Joppa Tasks and launch lanes
  within the configured dispatcher limit.
- [Auditor](audit/README.md): send confirmed code and specification deviations to an inbox.
  Missing implementation does not produce findings.

## Configuration

Pass a local JSON file to Dolber. Start from
[lane-launcher/dolber-joppa.example.json](lane-launcher/dolber-joppa.example.json).
Local configuration files are ignored by Git.

```sh
sh lane-launcher/dolber-joppa.sh /path/to/config.json --dry-run
sh lane-launcher/dolber-joppa.sh /path/to/config.json --once
```

`--dry-run` previews one selection without claiming or opening a tab.
`--once` starts at most one lane when `launchLanes` is true. Without either flag,
Dolber repeats at the configured interval until Ctrl+C.

The config supplies the Joppa workspace and project, workers, source root,
repositories with their target branches and checks, shared CBM connector,
Git key directory, dispatcher ID, and lane limit.
See [lane-launcher/dolber-joppa.md](lane-launcher/dolber-joppa.md).

## Runtime

The entire source root is read-only. Each Task run has a writable private checkout
at `<worktreeRoot>/<execution-id>` with its own `.git`. Run artifacts are
stored separately. Retained work is never reset by a new launch.

All lanes access shared host CBM storage through the configured connector. Crew
does not copy databases, start CBM daemons, or index worktrees. Equill supplies
role contracts and memory.
`roles/*.jsonl` are recovery snapshots; the live Equill store is authoritative.
Lane, planning and audit snapshots cover their seven roles; the shared snapshot contains
the common rules included in their contracts.
Do not import a stale snapshot over that store.

Enable the Crew pre-push hook in each checkout:

```sh
git config core.hooksPath .githooks
```

Before each push it exports these seven live contracts and their shared rules.
If snapshots change, the push stops: commit `roles/*.jsonl` and push again.
An Equill error also stops the push. The store defaults to `~/.equill/dev`;
override it with `EQUILL_STORE`. Run `python3 roles/export.py` to export manually.
Export is one-way: `git pull` never updates another machine's store. Lane and
planning and audit runs therefore start with `python3 roles/export.py --check`, and stop
when the live store differs from the committed snapshots. Bring the older side
up to date, then start again.

The worker claims the Task in Joppa from its Herdr tab before preflight or Docker.
After the lane ends, the worker completes, blocks, releases or holds the claimed
Tasks with the run evidence. An unconfirmed claim changes nothing. An uncertain
dispatch or outcome keeps its reservation for inspection.

Landing uses native repository hooks and a normal push. It refuses dirty work,
failed checks, an unreviewed tree, or a target ahead of the candidate. A lost
completion response after landing preserves the SHA and does not rerun implementation.

Nonblocking review findings stay in the run's `followups.txt`. They do not trigger
another implementation round.

## Build and checks

```sh
broker box build
docker build --build-arg USER_UID=$(id -u) -t medulla-crew:latest .
medulla -w lane --validate
node --test lane-launcher/test/*.test.mjs
python3 -m unittest discover -s lane/tests -v
```

The image extends `broker-box` with Medulla and repository check tools.
Build the optional Chromium variant for browser tests:

```sh
docker build -t medulla-crew-chromium:latest - < Dockerfile.chromium
```

Set `image` to `medulla-crew-chromium:latest` in the local dispatcher configuration.
The variant installs Chromium system libraries with Playwright `1.63.0`.
Set `PLAYWRIGHT_VERSION` to match the project's version and `RUNTIME_USER` to match the base image user.
The default runtime user is `501:501`. Browser downloads remain part of the project setup.

Each lane uses the broker's on-demand private Docker engine for integration tests.
Its Docker storage is removed with the lane container. No host Docker socket is mounted.
Host Medulla, Docker, Equill, Git credentials, and the shared CBM connector
must be available. Startup runs `lane-launcher/safe-sync.py`: each configured
canonical repository is locked, fetched, fast-forwarded to its
configured branch, and reindexed through the shared CBM connector. Up to four
repositories refresh in parallel with separate MCP connections. Each repository
lock is held until CBM reports ready for that canonical root.
Dirty or diverged sources stop startup. Dry runs do not refresh sources or CBM.
