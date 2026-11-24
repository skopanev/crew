Read {{var:RUN_ARTIFACTS}}/scout-contract.txt and execute its steps.
Task: {{var:ticket_id}}.
Read its source, workspace, checkout, checks and artifact paths: {{var:RUN_ARTIFACTS}}/scout-context.json.
Read the ticket:
  rtk proxy node /workspace/lane/bin/ticket-input.mjs --read {{var:ticket_id}} --workspace {{var:project_name}}
If the ticket has tasks, inspect every Task contract and its writable roots.
