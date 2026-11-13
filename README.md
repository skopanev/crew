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
does not copy databases, start CBM daemons, or index worktrees.

Role contracts and memory come from Joppa `POST /api/data`.
Set `context` in the launch config. It names the endpoint, optional workspace and root,
private `token_file`, role map, type selections, fields and filter bindings.
The key must be a workspace Read key (`jpr_`), not an MCP or mutation token.
SessionStart reads the complete contract. Prompt and tool hooks query scoped memory.
A failed baseline or a response above `max_chars` stops the agent without truncation.
No Equill binary, bridge or local store is required.

`roles/*.jsonl` retain the earlier recovery drafts. Runtime does not read them.
Git pushes do not export context or credentials. Joppa stores the current contracts.

The default runtime user is `501:501`. Browser downloads remain part of the project setup.

Each lane uses the broker's on-demand private Docker engine for integration tests.
Its Docker storage is removed with the lane container. No host Docker socket is mounted.
Host Medulla, Docker, curl, jq, Git credentials, and the shared CBM connector
must be available. Startup runs `lane-launcher/safe-sync.py`: each configured
canonical repository is locked, fetched, fast-forwarded to its
configured branch, and reindexed through the shared CBM connector. Up to four
repositories refresh in parallel with separate MCP connections. Each repository
lock is held until CBM reports ready for that canonical root.
Dirty or diverged sources stop startup. Dry runs do not refresh sources or CBM.
