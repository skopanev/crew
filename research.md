# Crew delivery research and current decisions

Updated: 2026-11-15. Runtime baseline: Crew main `4dfd472`.
Earlier research remains in the Git history of this file.
This document describes implementation facts and proposed work separately.
It does not change an owner decision, an acceptance criterion, or a test result.

## Delivery boundary

The owner defines requirements and acceptance criteria in Joppa.
Crew plans bounded work, implements it, checks it, and publishes evidence.
The configured target branch is the delivery destination.
A branch push does not prove target integration or acceptance.
Deployment remains a separate action.

One Task supplies one coherent result and includes the tests needed for that result.
Dependencies describe required outputs, rather than an arbitrary execution order.
Independent Tasks can run in parallel within the configured lane limit.
A missing product decision requires its owner.
A technical gap requires bounded implementation work when its intended behavior is already approved.

## Roles and context

Joppa stores the specification, execution nodes, Sources, rules, processes, and lessons.
Crew reads role context through `POST /api/data` with a workspace Read key.
The key has the `jpr_` prefix. It does not grant mutation access.
The launch config selects the endpoint, workspace, role bindings, process bindings, fields, and filters.
Role and process selectors remain separate fields.
Crew does not infer project names or require a project split.

SessionStart loads the complete required role contract.
Prompt and tool hooks request relevant additional memory.
Required context failures stop the agent. Oversized responses fail instead of losing text through truncation.
Confirmed lessons remain separate from an agent's unverified explanation.
The local `roles/*.jsonl` files retain recovery drafts. Runtime reads the current Joppa records.
Push hooks do not export private project context or credentials.

CBM supplies code relationships and search results.
The current checkout supplies the final implementation evidence.
Crew uses the configured shared connector. It does not copy CBM databases or index worktrees.
Source refresh uses one CBM session while Git refresh remains parallel.

## Planning questions

The necessity assessment asks whether the result is required and whether existing behavior already supplies it.
It identifies the minimum sufficient scope and possible reuse.
The designer receives that assessment and explains a mechanism in at most five steps.
The designer preserves approved behavior and names the outputs needed from dependencies.
Code locations and test placement remain implementation choices unless the criterion requires them.

Independent critics examine necessity, simplicity, correctness, safety, reuse, and needed extension points.
They reject evidence-backed defects. They do not reject a proposal only because they prefer another style.
A large result can require decomposition before detailed design.
The planner must not fully design many unrelated Tasks in one pass.
Missing implementation is work to plan. It does not justify an unrelated release or publication requirement.

## Independent test text

Writer uses the existing configured dispatcher, Medulla graph, claims, and native publication receipts.
Its author derives Test text from the criterion and its Sources, rather than a developer's proposed code.
Two independent critics check each Test and complete coverage.
One failed review permits one revision. A second failed review stops publication.
The host creates native Test nodes only after the required verdicts pass.
Created Tests keep their criterion's owner.
Writer publication does not prove that the product passes those Tests.

A live Writer trial published three Test nodes after both critics approved the revised text.
Implementation and acceptance results remain separate evidence.

## Implementation and integration

The lane executes the claimed Task within its approved scope.
It must not invent requirements, broaden scope, or replace a missing owner decision.
Required checks and expert review inspect the actual candidate.
Optional findings become separate work instead of creating an unlimited revision loop.
A startup failure before agent work releases the claim after the host confirms that no writer remains.
A failed implementation retains a concrete reason and its evidence.

A separate deterministic integration flow is in development.
Its planned input is a configured batch of checked branches from one repository.
It preserves the original commit ancestry, tests the combined candidate, and pushes normally to the configured target.
Only heads proven in target ancestry can complete their Tasks.
A failing combined check does not identify a guilty Task without further evidence.
A red target baseline must not become an accusation against a branch.
An uncertain native publication requires receipt recovery before another write.

## Simplicity constraints

Use the existing dispatcher and dashboard for configured flows.
Keep models, native filters, stages, repositories, limits, and intervals in configuration.
Use deterministic code for claims, Git operations, receipts, and routine status handling.
Use model judgment for interpretation, mechanisms, and evidence-based review.
Avoid a second queue, a second status store, and project-specific branches in Crew.
A green Task or a completed workflow does not establish criterion acceptance.
Native test results at the tested commit establish verification evidence.

## Earlier research references

The earlier study examined these sources. They remain references, rather than current runtime contracts.

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Letta: Shared memory](https://docs.letta.com/concepts/shared-memory)
- [Spotify: Feedback loops for background coding agents](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)

Read the current local implementation and the live Joppa contract before changing a workflow.
