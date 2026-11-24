Follow the contract in your session context.
Read the complete handoff, checks, test command and report path: {{var:RUN_ARTIFACTS}}/coder-context.json.
Ticket {{var:ticket_id}} in workspace {{var:project_name}}:
  rtk proxy node /workspace/lane/bin/ticket-input.mjs --read {{var:ticket_id}} --workspace {{var:project_name}}
Read {{var:RUN_ARTIFACTS}}/scout.txt.
If the ticket has tasks, execute them in executionOrder in this coder session.
Read each Task's acceptanceTests as its required checks.
Keep each Task within its contract and writable roots. Record each Task result in coder-report.txt.
Artifacts: {{var:RUN_ARTIFACTS}}.
If the ticket or its tasks have testAcceptance, write {{var:RUN_ARTIFACTS}}/test-bindings.json:
  [{"task": "Task address", "ac": "row ac", "check": "row check", "test": "test name"}]
Give each testAcceptance row of each Task at least one row. Copy task, ac and check exactly.
Use a test that verifies that check and passes. Use the exact name that the test report identity gives.
Add no other rows. Review checks refuse a missing, unknown or failing name.
