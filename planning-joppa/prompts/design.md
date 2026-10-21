Choose the smallest sufficient mechanism for the selected Joppa criteria.
For Requirement scope, use every AC in assignment.joppa.criteria. Otherwise use assignment.ac.
Follow the Equill contract, research, necessity assessment and additional output contract.
Read the Requirement, parent context and decisions.
Use existing Tasks where they already own required work. Preserve completed work and worker assignments.
Update only Tasks under the selected ACs. Preserve each Task's AC parent.
Reuse work under an external AC through depends_on. Do not rewrite its Tasks.
Use action retire only for an unclaimed blocked Task under a selected AC whose work is unnecessary.
Supply its target and current revision. Use outcome for the retirement reason. Keep depends_on empty.
Keep the usual Task fields and observable retirement checks. Never depend on a Task retired by this plan.
Update each remaining dependent Task to remove its dependency before you retire the target.
Give at most five mechanism steps and observable AC and module checks for each Task.
Lane chooses files, functions and test placement. Keep research citations outside Task outcomes, steps and checks.
Do not implement code or call mutations. Never claim that checks passed without evidence.
Use disposition implement, verify_existing or blocked. A blocked plan needs concrete blockers.
An implement plan needs Tasks. A verify_existing plan creates no Task.
It can retire an unnecessary blocked Task. Each acceptance check names the existing test and assertion evidence.
Use test (file > test name), evidence (repository:path:line), and optional source_ac for its recorded passing result.
Match each check to its AC disposition. An implement check uses scenario and expected.
A verify_existing check uses this shape:
{"ac":"selected AC address","repository":"registered repository ID","test":"repo-relative/file > test name",
 "evidence":"repository:test/path:line and repository:implementation/path:line","source_ac":"AC with the stored pass"}
Omit source_ac when the selected AC supplies the passing result.
Include citations for the assertions and affected implementation. A name or a source read does not prove a test passed.
Inspect the actual assertions. Cover every Then and Evidence item. Missing tests or behavior are implementation work.
When critic findings are supplied, resolve each blocking finding or refute it with source evidence.
Keep one Task in one repository and module. Add dependencies only when outputs require them.
Each Task must run and land independently. Declare dependencies only for required outputs, including within one repository.
Explicitly update or retire every unfinished Task under the selected ACs.
Title order does not replace depends_on links. Keep independent Tasks independent.
For Requirement scope, add criteria: [{ac, disposition}] for every selected AC.
Each Task and acceptance check must name its selected ac. Follow each AC's implementation or existing-test-binding disposition.
Apply the supplied writing rules. Return only one JSON object:

{"disposition":"implement","outcome":"Observable selected-scope outcome",
 "necessity":"Required work","approach":"Mechanism and interfaces",
 "rationale":"Why this approach is sufficient","alternatives":["Simpler alternative and its result"],
 "blockers":[],"acceptance_checks":[{"ac":"selected AC address","repository":"registered repository ID",
 "scenario":"Action and condition","expected":"Observable AC evidence"}],
 "tasks":[{"id":"task-1","action":"create","ac":"selected AC address",
 "title":"One coherent change","repository":"registered repository ID","module":"registered module",
 "outcome":"Task result","steps":["Mechanism step including failure behavior"],
 "reuse":["Verified mechanism"],"depends_on":[],
 "checks":[{"scenario":"Action and condition","expected":"Observable result"}]}]}
