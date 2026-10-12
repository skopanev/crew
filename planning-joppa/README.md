# Joppa planning

Status: planning published Tasks in a live run. Lane confirmed completion of both Tasks.
Task completion does not confirm criterion acceptance.

Run from the Crew repository:

```sh
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id --dry-run
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id
```

Use `config.example.json` as the shape of the private configuration.
Map Joppa Project addresses to local repositories and CBM indexes in that configuration.
Keep credentials and private configuration outside this repository.

Show the last 30 planning runs in a terminal table:

```sh
sh ./lane-launcher/planner-joppa.sh /path/to/private/config.json
sh ./lane-launcher/planner-joppa.sh /path/to/private/config.json --ac-id ac:criterion-id
```

The first command selects ready ACs and plans one at a time. The second starts one AC.
Use `--monitor` to show existing runs without starting work.
The table shows the start time, Requirement and AC titles, status, stage or reason code, run ID and duration.
Active runs appear first. The screen updates every five seconds.
Use `--once` to select at most one AC and exit after it finishes.
Use `--monitor --once` for one display snapshot.
The table reads existing Medulla journals and results. It creates no history database.
New runs save their output in `output.log` inside the Medulla run folder.
Ctrl+C stops this display and interrupts its own run. It does not stop other runs.
The automatic loop checks the queue every 60 seconds. Set `interval_seconds` in the config to change this interval.
It selects criteria in the configured workspace. Repository mappings bound Task publication.
It excludes criteria with active or completed Tasks to avoid repeating existing work.
It skips failed AC revisions for the rest of the process. Restart to try an unchanged revision again.
Unresolved planning receipts prevent another automatic claim. Recover these receipts first.

The input is one AC. The planner reads its Requirement, parents, decisions and existing Tasks.
It claims the AC for planning. It uses the shared graph and live Equill roles.
Research checks reuse. Necessity checks the minimum scope. Design supplies mechanisms.
Two independent critics review the plan. Publication saves Tasks and finishes the claim in one transaction.
The plan enters each Task contract. A verification Task checks existing behavior.
Publication does not confirm acceptance or mark the AC as passing.

The deployed server must support `claim_planning`, `finish_planning` and `release_planning`.
The planner refuses before claiming if those commands are absent.
Refresh the canonical source and its shared CBM index before launch.
Verify indexed paths in the inspected source. Do not index an isolated checkout.
Dependent Tasks need a server revision rule before unrestricted dispatch.
Task claim and completion change document revisions and invalidate dependency pins.
The confirmed initial scope permits independent verification Tasks.
Keep required dependencies explicit. Do not remove them to bypass this prerequisite.
Dry-run validates configuration without MCP calls, agent calls or writes.
The planning engine handles one AC per run. The dashboard selects the next AC after each run.

Crew planning updates only unclaimed implementation Tasks. It preserves Tasks with another purpose.
It skips unchanged documents and pins dependencies from the fresh context.
Before each claim, it checks previous receipts for this endpoint, workspace and AC.
Unresolved receipts block a new run. They require explicit recovery.
Confirmed failures release this run's planning claim. Uncertain mutations retain their request receipts.
Inspect `claim.json`, `publication.json` and `release.json` before recovery.
Use the recorded request ID and identical arguments if manual recovery requires a receipt replay.
Never start another mutation blindly. Planning claims do not expire.
An interrupted process can retain a claim. Release it explicitly after checking its publication receipt.

Current limits:

- A human can edit an unclaimed implementation Task. Crew can replace that contract if its reviewed revision still matches.
- A plan with unchanged Task contracts releases the claim. It does not finish planning, so another run can select the AC.
- Receipt checks compare endpoint URLs exactly. Keep the same URL, including its trailing slash, across runs.

Run the focused provider checks:

```sh
python3 -m unittest discover -s planning-joppa/tests
```
