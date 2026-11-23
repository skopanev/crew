#!/usr/bin/env bash
# The planned gate query of Dolber for tasker: crew/workflow/scripts/backend-test-local.sh in the Dolber lane image.
# check.mjs gives this directory to forecastPlanGate as its workflow directory, so the forecast logic stays unchanged.
# The host has no box runtime (backend-runtime.sh needs bun, node and docker on the box PATH), the lane image has it.
# Usage: as backend-test-local.sh, in the develop worktree. Needs DOLBER_CONFIG (its .image) and CREW_WORKFLOW_DIR.
main() {
set -euo pipefail
tree="$(git rev-parse --show-toplevel)"
common="$(cd "$tree" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
image="$(jq -er '.image' "$DOLBER_CONFIG")"
# Read-only mounts at the host paths, no network: the query reads the tree and runs nothing.
exec docker run --rm --network none --entrypoint bash \
  -v "$tree:$tree:ro" -v "$common:$common:ro" -v "$CREW_WORKFLOW_DIR:$CREW_WORKFLOW_DIR:ro" -w "$tree" \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  "$image" "$CREW_WORKFLOW_DIR/scripts/backend-test-local.sh" "$@"
}
main "$@"; exit $?
