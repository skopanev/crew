# NTK planning

Prepare one open NTK ticket or diagnose one blocked Lane failure.
This workflow uses the existing planning graph and live Equill roles.

```sh
sh ./planning-ntk/run.sh --config /path/to/config.json --ticket-id TICKET --dry-run
sh ./planning-ntk/run.sh --config /path/to/config.json --ticket-id TICKET
```

`--dry-run` validates the graph without calling NTK, Equill, CBM, or agents.
Use the same local JSON configuration as Dolber. It must contain `id`,
`workspace`, `sourceRoot`, `stateDir`, `tags`, `cbmMcpCommand`, and `cbmCacheDir`.
Set absolute paths. Keep the configuration outside Git.

Optional configuration:

```json
{
  "planning": {
    "tags": ["crew", "topic-a", "topic-b"],
    "tagMatch": "any",
    "dispatchTag": "crew",
    "equillStore": "/absolute/path/to/equill/store",
    "researchModel": "gpt-6.1-sol",
    "designModel": "claude-opus-5-5"
  }
}
```

Include `dispatchTag` in Dolber's required `tags`.
Set `planning.tags` to override the planner filter. Otherwise, it uses Dolber's tags.
Set `planning.tagMatch` to `any` for OR or `all` for AND. The default is `all`.
`strict` controls exact tag matching. It does not control OR or AND.
The planner adds all configured dispatch tags only after it confirms the plan and graph.
NTK selects eligible tickets after their prerequisites close.

## Process

1. Read the ticket, prerequisite graph, NTK metadata, attachments, and available Lane failure artifacts.
2. Inspect current source, Git history, shared CBM, Equill knowledge, and repository `.ntkrc` contracts.
3. Run parallel code, knowledge, and external research. Produce a concrete implementation plan.
4. Ask independent necessity, simplicity, and correctness critics to check that plan.
   A rejected plan goes back to design once, with the blocking findings. The critics then check the revision.
5. Confirm source versions and live role contracts before any publication. Publish the result to NTK.

The models and critic seats are the same as [Planning](../planning/README.md).
The planner reads canonical repositories. It does not update Git, index a worktree,
implement code, run project checks, or clean retained work.
Existing shared CBM must cover the inspected current files.
A Task body contains the required edit steps, acceptance criteria, and executable checks.
Attachments carry the full plan and reviews. They do not replace body instructions.

## Results

| Result | NTK state |
| --- | --- |
| READY, one Task | Update the source ticket and put it in `open` with dispatch tags. |
| READY, several Tasks | Create children with correct prerequisites. Put the parent in `to_review` without its dispatch tag. |
| NOT_READY | Keep the source `blocked`, remove its dispatch tag, and attach the concrete reason. |
| Critics reject the revised plan | Publish NOT_READY: the blocking findings become the reason, and the reviews go in the attachment. |
| NEEDS_HUMAN | Set `blocked`, prefix the title with `[HUMAN]`, assign the named person, remove its dispatch tag, and attach the exact decision. |
| Planning did not complete (tool, agent or environment failure) | Leave the ticket unchanged and record nothing as processed. Fix the cause and plan again. |
| Publication started and failed | Record `publication_uncertain`; part of the result may be in NTK. An operator inspects the ticket before another run. |

A split parent gets `[CLOSE AT NO DEPS] <original title>` and depends on all children.
Children never depend on the parent. Each child has one module and its own checks.
External prerequisites go only to children that need them.
The planner removes `[HUMAN]` when the next verdict no longer needs a person.
After the decision, record it in the ticket and restore the dispatch tag to plan it again.
All prepared children get dispatch tags, including children waiting for prerequisites.
The workflow does not close the parent automatically.

## Failure and retry

Active or completed tickets and live or unresolved Lane runs are excluded.
An existing `.worktrees/<ticket>` requires operator inspection. The planner does not delete it.
An unchanged processed verdict is refused until evidence, source, or the ticket changes.
An incomplete run is not a verdict and is never recorded as processed.
Text limits come from NTK metadata. The workflow refuses overflow without truncation.
Unread attachments remain listed by filename. Missing required evidence blocks readiness.

One file lock permits one planner per workspace in this local `stateDir`.
This lock does not coordinate different hosts or different state directories.
NTK has no revision compare-and-swap. The workflow checks revisions before publication.
Normal NTK guards refuse writes after Lane claims a ticket. The workflow never uses `force`.
A simultaneous human edit can still occur between the final read and write.

Child creation records each POST before sending it in a stable `publication.json`.
An uncertain POST stops. It never creates a replacement child automatically.
If NTK refuses a duplicate, inspect the refusal and receipt before another attempt.
Partial publication leaves unactivated children blocked without the dispatch tag.
Resume a confirmed parent publication from the same run:

```sh
sh ./planning-ntk/run.sh --config /path/to/config.json --ticket-id TICKET --resume /absolute/path/to/run
```

Resume checks the saved plan, critics, source versions, role contracts, parent, and children.
It activates unchanged blocked children and preserves already active children.
A parent write without a confirmed receipt requires operator inspection.
Run files are under `<stateDir>/planning-ntk/<workspace-hash>/runs`.
A prepared run processes one ticket. It does not add a second selection loop to Dolber.

## Blocked-ticket dispatcher

Dolber starts lanes for `open` tickets. A failed lane leaves its ticket `blocked`,
and review findings arrive as `blocked` tickets too. The dispatcher walks that pile:

```sh
sh ./lane-launcher/planner-ntk.sh /path/to/config.json --dry-run   # show the queue
sh ./lane-launcher/planner-ntk.sh /path/to/config.json --once      # plan one ticket
sh ./lane-launcher/planner-ntk.sh /path/to/config.json             # loop
```

Run these commands from the Crew repository root, as you run Dolber.
It uses Dolber's configuration. Each tick it reads `blocked` tickets with the
planner tag filter. A failed lane keeps the dispatch tag. A published NOT_READY
removes that tag. Other planner tags can still match the ticket, but the dispatcher
skips it until the ticket changes.
A `[HUMAN]` ticket stays out until its configured dispatch tag is added again.
An empty tag list is rejected. The dispatcher takes the longest-blocked ticket
and runs this workflow for it in a run directory it names, then reads that run's
result. A ticket unchanged since the last attempt is skipped.
If the source changed while a run planned (`code_drift`, nothing published), the
dispatcher refreshes sources and plans the same ticket once more; a second drift
stops the loop. A run without a verdict stops the loop and is not recorded as processed: the
environment failed before publication, or a publication started and did not
confirm (`publication_uncertain`). Inspect the ticket, fix the cause, start again.
After `publication_uncertain`, compare the ticket and `publication.json` in NTK
before any other run; resume only a confirmed parent publication.
A ticket with a retained `<sourceRoot>/.worktrees/<ticket>` is reported once and
left for an operator. An exclusive `dispatch.lock` allows one dispatcher per
workspace and fails closed: if no dispatcher runs, an operator removes the file. The interval is
`planning.dispatchIntervalSeconds`, else `intervalSeconds`, else 60. State and logs
are in `<stateDir>/planning-ntk/<workspace-hash>/dispatch.json` and `dispatch-logs/`.
