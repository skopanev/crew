# Sourced by lane/run.sh. An optional project workflow replaces lane/workflow.yaml.
# Medulla resolves -w and --cwd-ro from the Crew root, so Crew tools stay under /workspace.
cd "$TOOLING_ROOT"
workflow_args=(-w "${WORKFLOW_DIR#"$TOOLING_ROOT"/}")
workflow_file="${LANE_WORKFLOW_FILE:-}"
if [[ -n "$workflow_file" ]]; then
  [[ "$workflow_file" = /* && "${workflow_file##*/}" == workflow.yaml && -f "$workflow_file" &&
     ! -L "$workflow_file" && -s "$workflow_file" ]] || {
    say 'run.sh: LANE_WORKFLOW_FILE must name an absolute nonempty workflow.yaml file'
    exit 2
  }
  workflow_file="$(cd "$(dirname "$workflow_file")" && pwd -P)/workflow.yaml"
  # Medulla mounts an outside definition directory read-only. A Crew path is already in /workspace.
  workflow_args=(-w "${workflow_file#"$(pwd -P)"/}" --var "TOOLING_ROOT=/workspace")
  say "run.sh: workflow RO: $workflow_file"
fi
if [[ -n "${LANE_REVIEWERS_JSON:-}" ]]; then
  workflow_args+=(--var "REVIEWERS_JSON=$LANE_REVIEWERS_JSON")
fi
