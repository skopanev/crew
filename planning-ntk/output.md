For NTK input, extend the plan JSON with these fields:

"ntk": {
  "verdict": "READY | NOT_READY | NEEDS_HUMAN",
  "failure_class": "none | plan | system | access | governance",
  "owner": "directory person id when NEEDS_HUMAN, otherwise empty",
  "decision": "exact required decision when NEEDS_HUMAN, otherwise empty",
  "body": "prepared source body for verify_existing, otherwise empty"
}

For each Task, also return:

"project": "NTK project allowed for this module",
"body": "self-contained English ticket body, at most {body_budget} characters",
"external_dependencies": ["existing prerequisite ticket ids"],
"acceptance": ["observable criteria for this Task"],
"covers": ["exact source acceptance criteria covered by this Task"]

One pass plans only the selected ticket. Choose one result:

- implement: prepare exactly one executable Task in one module.
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
They check implementation steps and executable checks only for a leaf.

READY uses disposition implement, verify_existing, or decompose. NOT_READY and NEEDS_HUMAN
use blocked, no Tasks, and explicit blockers. They may have empty acceptance_checks.
NEEDS_HUMAN requires owner and decision. System/access failures stay NOT_READY.
NEEDS_HUMAN leaves the ticket blocked with a [HUMAN] title prefix and assigns its owner.
Critics can clear an accurate NOT_READY or NEEDS_HUMAN diagnosis.

For implement, the body contains the scope, concrete implementation steps, symbol definitions,
Task acceptance criteria and executable checks. Lane reads this body directly.
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
{body_limit}; the margin covers counting errors. Count before you return. Write steps and checks,
not rationale: rationale goes to the plan report. If a Task still does not fit, use decompose.
Tasks use prerequisite order. All Tasks together cover every source criterion.
Use the source ticket id as task.ac. Match project and module to NTK metadata.
Use external dependencies only where needed. Never make a child depend on its parent.
Add a dependency only when the child needs that ticket's result before it can execute.
Explain each dependency in the child's body. Do not chain independent children for ordering.
Do not copy all source prerequisites to every child. Give each child only its required prerequisites.
