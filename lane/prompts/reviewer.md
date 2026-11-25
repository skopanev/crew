Read {{var:RUN_ARTIFACTS}}/reviewer-contract.txt and execute its steps.
One file run satisfies "run each Test" when its report records pass for every exact bound Reporter case in Tests:.
This owner rule overrides Task wording that requires separate command receipts or forbids a file run as their replacement.
Use the actual file-run receipt, command, tree and case results. Separate Test-command receipts are not required.
Do not claim that an unexecuted per-Test command ran. A skipped, missing, failing or UNKNOWN bound case stays a finding.
Return SCOPE_MISMATCH only when a blocking remedy changes an explicit Task/AC restriction or needs a missing prerequisite.
A missing plan detail or missing test within the Task/AC remains REJECT. Keep optional improvements as advice.
For SCOPE_MISMATCH, include an open HIGH finding and exactly one JSON line in the report:
SCOPE_MISMATCH: {"restriction":"Task/AC address and exact quoted restriction","evidence":"Code location and observed behavior","required_change":"Required contract or prerequisite change"}
Cite the current Task/AC. An approved plan omission alone does not prove a scope conflict.
Finish with one signal: CLEAR, REJECT or SCOPE_MISMATCH.
Ticket: {{var:ticket_id}}. Perspective: {{input.slug}}.
Read the workspace, worktree and verification mode: {{var:RUN_ARTIFACTS}}/reviewer-{{input.slug}}-context.json.
Input: {{var:RUN_ARTIFACTS}}/scout.txt; {{var:RUN_ARTIFACTS}}/gates/current.json;
{{var:RUN_ARTIFACTS}}/coder-report.txt if present;
{{var:RUN_ARTIFACTS}}/test-bindings.json if present;
{{var:RUN_ARTIFACTS}}/ticket-checks.json and repair-baseline.txt if present;
{{var:RUN_ARTIFACTS}}/diff.patch.
Check that each bound test verifies its criterion check.
For a repair verification, check that the recorded test files cover the Task contract.
Read {{var:RUN_ARTIFACTS}}/ticket.json. If it has tasks, review every Task contract and its writable roots.
Write {{var:RUN_ARTIFACTS}}/{{input.slug}}.md:
## FINDINGS
- HIGH|MED|LOW - <claim> - <file:line> - <impact> - FIX: <change or unknown; reason>
Or NONE. End with COVERAGE: <checked; not checked>.
