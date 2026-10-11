For NTK, add decomposition to the assessment JSON.
Use null for one cohesive leaf or a required owner decision.
For a split, return the existing plan shape inside decomposition:

{"disposition":"decompose",
 "outcome":"Complete source outcome",
 "necessity":"Why this work is needed",
 "approach":"Outcome boundaries, without implementation design",
 "rationale":"Why these children are independently deliverable",
 "alternatives":["Why one leaf is insufficient"],
 "blockers":[], "acceptance_checks":[],
 "ntk":{"verdict":"READY","failure_class":"none","owner":"","decision":"","body":""},
 "tasks":[{"id":"task-1","ac":"source ticket id","title":"Narrower outcome",
           "repository":"registered repository id","module":"registered module name",
           "project":"registered NTK project","outcome":"Child outcome",
           "body":"Scope, outcome, AC, constraints, decisions and dependency outputs. Reference the source ticket.",
           "acceptance":["Observable child criterion"],
           "covers":["Exact source criterion"],
           "depends_on":[],"external_dependencies":[]}]}

Return at least two distinct children. Together, they cover the complete source AC.
Use prerequisite order. depends_on names earlier child IDs.
external_dependencies names only verified prerequisite or referenced ticket IDs.
Never depend on the source or its dependants. Keep independent children parallel.
Each child belongs to one registered repository, module and project.
Use source decisions and prior critic findings from the supplied attachments.
Do not add steps, checks, write_paths, reuse or nested tasks to children.
At coordinator distance three, return null and assess one leaf.
Keep each body below {body_budget} characters and each title below {title_limit}.
The post hook sends a split to the existing critics without invoking the designer.
