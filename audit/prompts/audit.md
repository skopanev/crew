Read and execute the mandatory role contract: {{var:AUDIT_CONTRACT_PATH}}.
Read the audit input: {{var:AUDIT_INPUT}}.
Inspect implemented code behavior. Use the read-only service MCP to find its current requirements and context.
Return only JSON:
{"inspected":[{"repository":"configured ID","path":"tracked source file"}],"limitations":[],
 "findings":[{"id":"unique ID","kind":"contradiction or uncovered","title":"Short finding",
   "actual":"Implemented behavior","required":"Required behavior","impact":"Observable effect",
   "code":[{"repository":"configured ID","path":"tracked source file","line":1,"quote":"Exact source lines"}],
   "spec":[{"address":"source address","revision":1,"quote":"Exact specification text"}],
   "spec_searches":["For uncovered only: the exact query argument string from a successful service search"],
   "why_uncovered":"For uncovered only: why current requirements do not cover this observable behavior",
   "decision":"For uncovered only: ask the owner whether to specify, change or remove the behavior"}]}
For uncovered behavior, use spec: [] and omit required. It needs no invented requirement quotation.
In spec_searches, include only literal query argument values from successful whole-workspace service searches without a kind filter.
Do not include tool call syntax, other arguments, local searches or explanations in spec_searches.
Use an empty findings list when no deviation is supported. State inspection limits.
