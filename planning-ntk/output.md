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
"body": "self-contained English ticket body, at most the NTK body limit",
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
Tasks use prerequisite order. All Tasks together cover every source criterion.
Use the source ticket id as task.ac. Match project and module to NTK metadata.
Use external dependencies only where needed. Never make a child depend on its parent.
