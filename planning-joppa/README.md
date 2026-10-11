# Joppa planning

Status: native launch, role loading, claim and confirmed failure release passed a live run.
Task publication has not passed a complete live run yet.

Run from the Crew repository:

```sh
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id --dry-run
sh ./planning-joppa/run.sh --config /path/to/private/config.json --ac-id ac:criterion-id
```

Use `config.example.json` as the shape of the private configuration.
Map Joppa Project addresses to local repositories and CBM indexes in that configuration.
Keep credentials and private configuration outside this repository.

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
This entry point handles one AC. It does not run a dispatcher or change NTK planning.

Crew planning updates only unclaimed implementation Tasks. It preserves human and other-purpose work.
It skips unchanged documents and pins dependencies from the fresh context.
Before each claim, it checks previous receipts for this endpoint, workspace and AC.
Unresolved receipts block a new run. They require explicit recovery.
Confirmed failures release this run's planning claim. Uncertain mutations retain their request receipts.
Inspect `claim.json`, `publication.json` and `release.json` before recovery.
Use the recorded request ID and identical arguments if manual recovery requires a receipt replay.
Never start another mutation blindly. Planning claims do not expire.
An interrupted process can retain a claim. Release it explicitly after checking its publication receipt.

Run the focused provider checks:

```sh
python3 -m unittest discover -s planning-joppa/tests
```
