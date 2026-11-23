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
Keep preserves all text. Update reuses the existing ID and changes only title, body, command or an unchanged case.
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
rtk proxy bun test --timeout 30000 writer/publication.test.mjs writer/reconcile.test.mjs writer/workflow.test.mjs
```

The coordinator reviews the patch and runs three actual AC dry runs before joint release with the auditor.
