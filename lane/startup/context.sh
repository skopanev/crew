# Sourced by lane/run.sh. The worker supplies only a workspace Read key.
context_dir="${LANE_MEMORY_DIR:-}"
[[ -n "$context_dir" && -f "$context_dir/config.json" && -f "$context_dir/token" ]] || {
  say 'run.sh: Joppa context config and workspace Read key are required'
  exit 2
}
mounts+=(--mount "$context_dir")
context_vars=(
  --var "LANE_MEMORY_CONFIG=/workspace/$(basename "$context_dir")/config.json"
  --var "LANE_MEMORY_PROJECT=$project"
  --var "LANE_MEMORY_TICKET=$ticket"
  --var "LANE_MEMORY_MODULE=$module"
)
for role in scout coder reviewer gitfix; do
  [[ "$role" != scout || "${LANE_SCOUT:-true}" != false ]] || continue
  name="$(jq -er --arg role "$role" '.roles[$role] | select(type == "string" and test("\\S"))' "$context_dir/config.json")" || {
    say "run.sh: context.roles.$role is required"
    exit 2
  }
  context_vars+=(--var "LANE_MEMORY_${role}_ROLE=$name")
done
say 'run.sh: Joppa context configured'
