# Decision evidence

`BRAIN_ROOT` names a local evidence directory. Set it to the document directory of the configured project.
`BRAIN_EXCLUDE` excludes an obsolete document directory. `MANUALS_ROOT` names the second evidence directory.

Set `ARCHIVE_HOOK` to `bun /path/to/crew/decider/archive-hook.mjs`.
Set `ARCHIVE_LANE_CONFIG` to the Dolber config for the same workspace and tracker.
Set `ARCHIVE_STOP_SECONDS` to the maximum wait for an owned lane to stop.

If an archive reports an uncertain result, preserve its run directory and claim.
Read `publication.json`, `archive-plan.json`, and every `archive-batch-*.json` receipt.
Compare each operation with the current tracker state before an operator completes the remaining work.
Do not delete the receipts or repeat the hook to bypass its publication barrier.
These settings supply local files through the document reader. They do not require another application.

The research output uses `brain` and `manuals` as labels for these two configured directories.
The tracker workspace and all directory paths come from the configuration.
