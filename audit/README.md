# Code and specification audit

This Medulla workflow reports implemented behavior that contradicts the current specification or violates an explicit scope boundary.
It skips missing implementation, missing tests and unsupported preferences.
Helper code and implementation choices need no separate specification entry.

Graph: `prepare → audit → review → finish`. No findings skip the review stage.
The auditor uses `gpt-6.1-sol` with high effort. An independent `claude-sonnet-5-5` reviewer checks each proposed finding.
The launch configuration can change both models. Rules come from the live Equill process `crew-audit-auditor`.
The rules enter each model stage. They do not depend on a hook before each tool call.
Both agents use the existing shared CBM index through the same native server as planning and development.
Start with a scoped CBM search. Verify its results in current source.

The core workflow contains no service API or project identifiers.
A service adapter supplies `prepare`, `recheck` and `publish` operations.
The Joppa adapter is in `audit-joppa/`.

## Run with Joppa

From the Crew repository:

```sh
sh ./lane-launcher/auditor-joppa.sh /path/to/audit.json --dry-run
sh ./lane-launcher/auditor-joppa.sh /path/to/audit.json --no-publish
sh ./lane-launcher/auditor-joppa.sh /path/to/audit.json
```

Copy `audit-joppa/config.example.json` to a local configuration file.
Use one credential belonging to the invoking user. The workflow creates no agent identities or separate reader tokens.
The read-only MCP bridge uses that same credential. Only the final host stage can publish inbox entries.
Use a registered Equill reader for `equill_actor`.

`--dry-run` checks the configuration and prints the selected graph inputs without API calls, agents or writes.
`--no-publish` runs both model stages and saves the confirmed findings without inbox writes.
The normal command runs one audit. It does not start a dispatcher or a background daemon.

The configuration selects repository paths, workspace, inbox kind and inbox owner.
Set `cbm_root`, `cbm_store` and each repository's existing `cbm_project`, as in the planner configuration.
Optional `cbm_command` selects the native server executable. It defaults to `CBM_BIN` or `codebase-memory-mcp`.
Preflight requires a ready shared project whose source root matches the configured repository.
Both agents receive only the ten CBM read tools. The workflow checks actual successful search calls for the inspected repositories.
It does not copy a database, index a repository or start a watcher.
The inbox type must have `inbox: true` in the workspace schema.
Set `inbox.parent` when that type requires a parent.
Set `inbox.body_field` when its text field differs from `body`.
Use `inbox.fields` for additional required document fields.
Optional `roots` restricts the specification to named objects, their descendants and their ancestors.
Without roots, the adapter reads the configured workspace. It excludes Task and inbox documents from authoritative specification input.
Agents can read related service context through MCP. A finding must cite specification text in the recorded audit scope.

## Evidence and publication

Audit only clean tracked source. Untracked files do not supply code evidence.
Each finding needs an observable effect, exact source lines and an exact specification quotation with its revision.
The inbox schema supplies the title limit. Multiple quotations from one object produce one link.
Excess functionality also needs a quoted scope restriction.
The independent reviewer confirms or dismisses each finding. It cannot add findings.

The workflow checks code, specification revisions, schema and Equill rules again before publication.
It also rereads cited objects and their parents to detect changed owner comments or attachments.
Changed evidence stops publication. Audit output identifies the inspected files and inspection limits.
An empty report means no confirmed deviation in that inspection. It does not certify the entire product.

The Joppa writer creates only new documents of the configured inbox type.
It preserves existing specification, code, Tasks, test results and readiness.
Stable finding IDs prevent a repeated audit from creating another identical inbox entry.
An archived matching entry stops publication for inspection.
An uncertain write leaves `artifacts/publication.json` for inspection. The workflow does not repeat an uncertain mutation blindly.
A confirmed service refusal records `rejected`. An explicit rerun can retry after correction.
The service can change after the final check. Findings therefore name their exact source commits and specification revisions.

## Verification

```sh
node --test audit/tests/audit.test.mjs
```

The tests use disposable Git repositories and a local MCP fixture.
They also run the actual Medulla graph with fixture model executables.
They do not use production credentials or make live model calls.
