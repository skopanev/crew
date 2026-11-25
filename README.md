# Crew

Medulla workflows for planning Joppa Tasks, implementing them and auditing code against the specification.

## Workflows

- [Joppa planning](planning-joppa/README.md): plan one acceptance criterion or Requirement
  and publish scoped Joppa Tasks. [planning](planning/README.md) holds its shared graph.
  [Writer](writer/README.md) independently reviews Test text before implementation.
- [Lane](lane/README.md): implement one claimed Joppa Task, check it, review it and
  deliver it. The host worker records the outcome in Joppa.
- [Dolber](lane-launcher/README.md): select available Joppa Tasks and launch lanes
  within the configured dispatcher limit.
- [Lander](lander/README.md): integrate checked branches, run full batch checks, and complete only Tasks proven in target ancestry.
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

Start a panel in a versioned environment with:

```sh
node lane-launcher/environment.mjs /path/to/environment.json --run
```

The environment specification declares the code sources and path bindings:

```json
{
  "root": "/path/to/environments",
  "sources": {
    "engine": {"repository": "/path/to/crew", "ref": "engine-v69"},
    "role": {"repository": "/path/to/roles", "ref": "main"}
  },
  "config": {"source": "role", "path": "panel.json"},
  "bindings": {
    "workflow": "{role}/workflow/workflow.yaml",
    "vars.CODE_DIR": "{role}/workflow"
  },
  "external": ["context.token_file"],
  "command": ["sh", "{engine}/lane-launcher/planner-joppa.sh", "{config}"]
}
```

The installer resolves each Git ref to a commit and creates detached worktrees.
It binds only the declared fields. External fields remain live, including credential paths.
Plain labels stay unchanged when a source directory has the same name.
Managed paths cannot contain a `..` segment. Name another source explicitly instead.
The native filesystem resolver checks the complete symbolic link chain before a code path can run.
Use absolute paths for external resources and run artifacts.
It checks the code and generated config again before reuse.
Without `--run`, it installs the environment and prints its manifest.
Use an immutable engine tag from [Engine releases](ENGINE_RELEASES.md).
Old panels and workers retain their paths. Remove an old environment only after all its processes finish.
Keep run artifacts outside the code worktrees.

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
repositories refresh Git in parallel. Their CBM calls use one shared MCP session. Each repository
lock is held until CBM reports ready for that canonical root.
Dirty or diverged sources stop startup. Dry runs do not refresh sources or CBM.
