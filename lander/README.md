# Lander

Lander integrates checked Task branches through the existing configured dispatcher and Medulla.
It uses no model and has no separate queue, claim store, or dashboard.

```sh
sh lane-launcher/lander.sh /absolute/lander.json
sh lane-launcher/lander.sh /absolute/lander.json --once
```

Start from `config.example.json`. Replace its native kinds, stages, filters, commands, and paths with your configuration.
The example selects at most five pending Tasks from one repository every 30 minutes.
Use the native `selection` filter to control eligibility. Crew adds no project or hold filter.

## Input

Use Dolber `delivery: branch`, explicit focused `reviewCommands`, and `pendingDeliveryData` for the waiting stage.
A successful branch publication keeps the Task live, clears its assignee, and records its repository and checked commit.
Its `data.delivery` contains `state: pending`, `branch`, `head`, `target`, and the producer run ID.
Coder selection skips pending delivery. Only Lander archives a Task after target integration.

The Lander config supplies repository paths, target branches, full gate commands, and an optional setup command.
The commands select their runtime. Docker projects must supply Docker commands or a project wrapper.
Git uses the launch environment. A configured `vars.GIT_SSH_COMMAND` can select an existing private key.
No credentials belong in the public configuration example.

## Flow

1. The shared stage selects and claims the configured batch atomically.
2. Lander pins each declared head and creates one private integration checkout.
3. It merges the branches with commit ancestry preserved and runs the full configured checks once on a green batch.
4. The shared stage checks the input revisions again. Lander rechecks the remote heads and pushes normally.
5. Native publication archives only heads proven in target ancestry and releases every claim. Cleanup removes the integration checkout.

The canonical source repository stays unchanged. Repository hooks remain enabled.
Existing gate receipts and `lane/bin/land.sh` protect the push.
The configured gate timeout bounds each check and the push, including repository hooks. Medulla bounds each stage.

## Failures

A red combined check first requires a target baseline check.
A red baseline leaves all branches pending. It does not identify a faulty Task.
For a green baseline, Lander checks branches separately and then builds a passing combination.
An interaction failure names an incompatible combination. It does not accuse a branch that passed alone.
Previously checked exact candidates reuse their receipts.

A failed branch receives `vars.FAILED_DATA`, a cleared delivery field, and an evidence note.
The patch must use the project's native fields. It cannot override the assignee, commit, repository, or delivery metadata.
Original remote branches remain available for repair.
A moved target permits one rebuild and a new full check. A second move leaves the remaining work pending.
A moved or unavailable branch is excluded before the push. Its pending delivery stays unchanged with an evidence note.
With `repeat: true`, Lander retries that pending head each interval until the producer records a current reviewed head.

A partial landing reports `PARTIAL_LANDING`. Landed Tasks are archived, and excluded Tasks retain the repair evidence.
An uncertain native write requires receipt recovery before another claim.
A landed Task does not prove criterion acceptance. The workflow never writes a passing acceptance result.
