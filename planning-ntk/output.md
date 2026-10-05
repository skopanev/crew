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

READY uses disposition implement or verify_existing. NOT_READY and NEEDS_HUMAN
use blocked, no Tasks, and explicit blockers. They may have empty acceptance_checks.
NEEDS_HUMAN requires owner and decision. System/access failures stay NOT_READY.
Critics can clear an accurate NOT_READY or NEEDS_HUMAN diagnosis.

Each body contains the scope, concrete implementation steps, symbol definitions,
Task acceptance criteria and executable checks. Lane reads this body directly.
The full plan is an attachment. An attachment cannot replace mandatory body instructions.
For verify_existing, put a JSON array named TICKET_CHECKS in ntk.body.
Use existing runnable test-file paths, or checks with ac, argv and optional stdout.
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
Cover all acceptance criteria and prescribed checks. Missing executable evidence means NOT_READY.
Keep each body and title within {body_budget} and {title_limit} characters. NTK rejects more than
{body_limit}; the margin covers counting errors. Count before you return. Write steps and checks,
not rationale: rationale goes to the plan report. If a Task still does not fit, split it.
Tasks use prerequisite order. All Tasks together cover every source criterion.
Use the source ticket id as task.ac. Match project and module to NTK metadata.
Use external dependencies only where needed. Never make a child depend on its parent.
