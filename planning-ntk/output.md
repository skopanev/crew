For NTK input, extend the plan JSON with these fields:

"ntk": {
  "verdict": "READY | NOT_READY",
  "failure_class": "none | plan | system | access | governance",
  "owner": "empty",
  "decision": "empty",
  "body": "prepared source body for verify_existing, otherwise empty"
}

For each Task, also return:

"project": "NTK project allowed for this module",
"body": "self-contained English ticket body, at most {body_budget} characters",
"external_dependencies": ["existing prerequisite ticket ids"],
"acceptance": ["observable criteria for this Task"],
"covers": ["exact source acceptance criteria covered by this Task"]

One pass plans only the selected ticket. Choose one result:

- implement: prepare exactly one Task with mechanism steps in one module.
- verify_existing: prepare checks for the selected ticket, with no Tasks.
- decompose: divide the source into at least two smaller children, one level only.

For decompose, override the base Task schema. Use acceptance_checks: [] and
return each child with only id, ac, title, repository, module, project, outcome,
body, acceptance, covers, depends_on, and external_dependencies.
Each body contains its narrower scope, outcome, acceptance criteria, constraints,
and approved decisions. Reference the source ticket. Keep the children distinct.
All children together preserve the complete source scope and acceptance criteria.
Do not write child edit steps, executable checks, file lists, or nested children.
Each child receives its own planning pass later. Research only the boundaries
needed to divide this source. Do not design all child implementations now.
Allow at most three decomposition levels. Use the maximum coordinator distance in ntk.deps.down.
At that limit, prepare one leaf or return a concrete blocker.
Critics check coverage, boundaries, and dependencies for decompose.
Before review, the adapter adds creation_candidates to the frozen plan.
Each candidate includes its full ticket, revision and similarity score.
Both critics must add creation_checks to their JSON response:
[{"task":"task-1","id":"existing-ticket-id","distinct":true,"reason":"The work differs because ..."}].
Return one decision for every candidate of every child. Compare outcomes and
acceptance criteria, not titles. A completed ticket can already cover the work.
For the same work, set distinct to false and add a blocking finding naming the
existing ticket. Design uses the existing revision round to remove duplicated
work or return NOT_READY. Never edit or reopen another ticket to make a plan fit.
When there are no candidates, creation_checks can be empty.
For a leaf, they check mechanisms and observable acceptance checks.
Files, functions, test placement and build wiring belong to lane.

READY uses disposition implement, verify_existing, or decompose. NOT_READY
use blocked, no Tasks, and explicit blockers. They may have empty acceptance_checks.
The early necessity assessment owns NEEDS_HUMAN. It stops before design and assigns the named human.
If design finds a new required owner decision, return NOT_READY with the exact missing decision.
System/access failures stay NOT_READY. Critics can clear an accurate NOT_READY diagnosis.

For implement, the body contains the scope, numbered mechanism steps, reuse,
Task acceptance criteria, observable checks and required dependency outputs.
Do not prescribe edit files, functions, test placement or build wiring.
Source citations are evidence, not edit instructions. Lane reads this body directly.
The full plan is an attachment. An attachment cannot replace mandatory body instructions.
For verify_existing, put TICKET_CHECKS: followed by a JSON array in ntk.body.
Use test-file paths from current source or declared prerequisite outputs, or checks with ac, argv and optional stdout.
Copy the prescribed checks into the body. Each ac identifies its covered criterion.
Use only these read forms for argv. Each PATH is relative to the repository root:

    git check-attr ATTRIBUTE -- PATH...
    git ls-files -- PATH...
    git ls-files --error-unmatch -- PATH...
    grep -Fq -- LITERAL PATH
    test -e|-f|-d|-s PATH

The first two forms require exact stdout, including newlines. Other forms require exit 0.
If stdout is supplied, it must match exactly. These checks cannot use shell syntax.
git check-attr prints "PATH: ATTRIBUTE: VALUE" per path. git ls-files prints one tracked path per line.
Use one grep check per literal line.
Example: {"ac":"AC-2","argv":["grep","-Fq","--","required text","config.json"]}.
Cover all acceptance criteria and prescribed checks. Missing check specifications mean NOT_READY.
Describe checks against declared prerequisite outputs. Do not require passing results during planning.
Keep each body and title within {body_budget} and {title_limit} characters. NTK rejects more than
{body_limit}; the margin covers counting errors. Count before you return. Write mechanisms and checks,
not rationale: rationale goes to the plan report. If a Task still does not fit, use decompose.
Tasks use prerequisite order. All Tasks together cover every source criterion.
Use the source ticket id as task.ac. Match project and module to NTK metadata.
Use external dependencies only where needed. Never make a child depend on its parent.
Existing dependencies and verified tickets in ntk.referenced are eligible.
Missing or unread references are not eligible. Do not claim their coverage.
Read referenced ticket bodies from details_file. The inline context contains metadata only.
Cite ticket IDs for referenced facts used in the plan or diagnosis.
The source ticket and its dependants cannot become dependencies.
Add a dependency only when the child needs that ticket's result before it can execute.
Explain each dependency in the child's body. Do not chain independent children for ordering.
Do not copy all source prerequisites to every child. Give each child only its required prerequisites.
