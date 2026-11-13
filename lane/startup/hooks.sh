# Sourced by lane/run.sh. Optional custom hook settings are copied by the worker and mounted read-only.
hooks_dir="${LANE_HOOKS_DIR:-}"
hooks_vars=()
if [[ -n "$hooks_dir" ]]; then
  [[ -d "$hooks_dir" && -f "$hooks_dir/settings.json" ]] || {
    say 'run.sh: custom hook settings file is required when LANE_HOOKS_DIR is set'
    exit 2
  }
  jq -e 'type == "object" and (.hooks | type == "object")' "$hooks_dir/settings.json" >/dev/null 2>&1 || {
    say 'run.sh: custom hook settings file must be a JSON object with hooks'
    exit 2
  }
  mounts+=(--mount "$hooks_dir")
  hooks_vars=(--var "LANE_HOOKS_CONFIG=/workspace/$(basename "$hooks_dir")/settings.json")
  say 'run.sh: custom hook settings configured'
fi
