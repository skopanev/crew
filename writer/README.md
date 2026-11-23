# Writer reconciliation

Set `TEST_OPERATION` to `reconcile` to process an AC that already has Tests.
The `create` and `update` modes also return reviewed refusals to `to_decide` with a note.
For `update`, permit the selected AC kind and the Test kind in `publication.update_kinds`.
Permit `note` in `publication.allowed_operations`. Successful updates still change only the same Tests.
The author uses the current AC, Sources and captured Tests. The agents receive no code tools.

The draft contains the complete final Test set and explicit retirements:

```json
{
  "tests": [
    {"id": "existing", "action": "keep", "title": "Existing title", "data": {}},
    {"id": "changed", "action": "update", "title": "Corrected title", "data": {"body": "Current acceptance text"}},
    {"id": "new_1", "action": "create", "title": "Missing behavior", "data": {"body": "Required acceptance text"}}
  ],
  "retire": [{"id": "obsolete", "reason": "Why it is obsolete", "evidence": "Current AC or Source evidence"}],
  "coverage": "How the final set covers the current AC and Sources"
}
```

Every captured Test needs exactly one keep, update or retirement disposition.
Keep preserves all text. A Test that covers the AC and its Sources stays.
Update reuses the existing ID and changes only title, body, command or an unchanged case.
Each update row adds `finding: {test_quote, reason_code}`. The quote occurs in the captured Test.
Both reviews add `updates: [{id, agree, evidence}]`, and both agree that the captured Test does not cover the AC.
The host sends only changed authored fields. It preserves owner, results, history, relations and unmentioned metadata.
Archive retains the obsolete node and its recorded evidence. Its journal reason includes the reviewed retirement evidence.
Create cannot reuse an existing Test ID or title. It copies the AC owner.

`reconcile.validate` reuses `draft.jq` for native name, field, case and required-field rules.
It also checks the complete disposition set, final title uniqueness and the native batch limit.
`reconcile.review` requires exactly two reviews with the current draft digest.
Both reviews score every final Test and explicitly agree with every retirement.
Each review adds `retirements: [{id, agree, evidence}]`, or an empty array when the draft retires nothing.
Final coverage includes kept Tests and updated text. It excludes retired Tests and old updated text.

Approved output saves the claimed AC to `to_task` before Test changes.
Updates and archives use captured native revisions. Creates follow archives so the final Test count can respect the schema limit.
The shared engine combines the AC stage save with its claim release and sends one batch of at most 100 operations.
The Writer adds no network publisher.

## AC outcomes and returns (scheme crew_team)

The project config names `READY_STAGE`, `RETURN_STAGE`, `FINDING_CRITERIA`, `RETURNS_LIMIT` and `STUCK_TAG`.
The schema of the selected kind must hold both stages and the `returns` and `tags` fields.

- READY moves the AC to `READY_STAGE` and sets `returns` to 0.
- An AC defect moves the AC to `RETURN_STAGE`, adds 1 to `returns` and writes a note with every finding in full.
  A critic reports it in `ac_findings: [{criterion, ac_quote, source_quote, source}]`.
  The criterion is a letter of `FINDING_CRITERIA`. The AC quote occurs in the AC.
  The source is a referenced Source of the AC, and the quote occurs in its text. Writer does not count a sibling AC.
  The auditor checks siblings and R, so the Writer config omits R.
  Without such a finding, the AC does not go to `RETURN_STAGE`.
- A GAP adds `SOURCE_GAP_TAG` and keeps the stage and `returns`.
- INVALID and REJECTED keep the stage, add 1 to `returns` and write a note with every critic finding in full.
- At `RETURNS_LIMIT` the AC gets `STUCK_TAG` and a note with a question to the Owner.
- `exclude_tags` holds `STUCK_TAG` and `SOURCE_GAP_TAG`. The shared queue compares whole tags.
- The config has no `failure_escalation`. A technical failure releases the claim and keeps the stage.

An empty Source-gap draft uses `tests: []`, `retire: []` and `coverage: "GAP. <missing detail>"`.
Both critics review the gap. An owner decision changes no Tests.
The existing source-gap, coverage-gap and rejection routes remain available in their respective modes.

For an actual dry run, set `vars.DRY_RUN` to `"true"` and frozen root `failure_notes` to `false`.
Use a separate runs folder and the isolated workflow path.
`control.policy` checks the central failure policy before the shared stage claims the AC.
`control` stores the proposed business operations in `would-publish.json` and passes empty operations to the shared publisher.
This applies to approvals, Source gaps, coverage gaps and rejections. Unexpected failures use the shared release-only policy.
Repeated preview preserves the original proposal.

Run the bounded tests with:

```sh
node --test writer/
```

The coordinator reviews the patch and runs three actual AC dry runs before joint release with the auditor.
