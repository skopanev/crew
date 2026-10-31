#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Herdr panes need explicit CRLF for shell messages.
say() { printf '%s\r\n' "$*" >&2; }
RUNS_FOLDER="${LANE_RUNS_FOLDER:-$HOME/.medulla/lane-runs}"
TOOLING_ROOT="$(cd "$WORKFLOW_DIR/.." && pwd)"
source "$WORKFLOW_DIR/startup/usage.sh"

ticket="" project="" source_root="" module="" ssh_dir="${LANE_SSH_DIR:-}" cbm_command="" cbm_cache="" dispatcher_id=""
image="${MEDULLA_IMAGE:-medulla-crew:latest}"
after_land=""
test_command='[]'
gate_timeout=900
coder_timeout=""
also=()
writable=()
gate_commands=()
review_commands=()
passthrough=()
while (( $# )); do
  case "$1" in
    --ticket-id) ticket="${2:-}"; shift 2 ;;
    --dispatcher-id) dispatcher_id="${2:-}"; shift 2 ;;
    --project) project="${2:-}"; shift 2 ;;
    # Removed flags must not reach Medulla as passthrough mounts.
    --repo|--repo=*) say "run.sh: ${1%%=*} was removed; use --source-root"; exit 2 ;;
    --source-root) source_root="${2:-}"; shift 2 ;;
    --module) module="${2:-}"; shift 2 ;;
    --planning-result|--planning-result=*|--planning-task|--planning-task=*)
      say "run.sh: ${1%%=*} was removed with the legacy planner"; exit 2 ;;
    --runs-folder|--runs-folder=*) say "run.sh: use LANE_RUNS_FOLDER; dispatcher identity must remain in the run path"; exit 2 ;;
    --mount-ro) also+=("${2:-}"); shift 2 ;;
    --mount-rw) writable+=("${2:-}"); shift 2 ;;
    --shared-lock-dir) shared_lock_dir="${2:-}"; shift 2 ;;
    --ssh-dir) ssh_dir="${2:-}"; shift 2 ;;
    --cbm-mcp-command) cbm_command="${2:-}"; shift 2 ;;
    --cbm-cache-dir) cbm_cache="${2:-}"; shift 2 ;;
    --gate-command) gate_commands+=("${2:-}"); shift 2 ;;
    --review-command) review_commands+=("${2:-}"); shift 2 ;;
    --gate-timeout) gate_timeout="${2:-}"; shift 2 ;;
    --coder-timeout)
      coder_timeout="${2:-}"
      [[ "$coder_timeout" =~ ^[1-9][0-9]*$ ]] || { say 'run.sh: --coder-timeout must be a positive integer'; exit 2; }
      shift 2 ;;
    --test-command) test_command="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) passthrough+=("$1"); shift ;;
  esac
done
[[ -n "$ticket"  ]] || { say "run.sh: --ticket-id is required"; usage; }
[[ -n "$project" ]] || { say "run.sh: --project is required"; usage; }
[[ -n "$source_root" ]] || { say "run.sh: --source-root is required"; usage; }
[[ "${LANE_DELIVERY:-target}" = branch || -n "${shared_lock_dir:-}" ]] || {
  say 'run.sh: target delivery requires --shared-lock-dir'; exit 2; }
[[ "$ticket" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { say "run.sh: invalid ticket id"; exit 2; }
[[ -x "$cbm_command" ]] || { say "run.sh: --cbm-mcp-command must name an executable host CBM server"; exit 2; }
[[ -n "$cbm_cache" && -d "$cbm_cache" ]] || { say "run.sh: --cbm-cache-dir must name the existing shared CBM store"; exit 2; }
(( ${#gate_commands[@]} )) || { say "run.sh: --gate-command is required"; usage; }
[[ -n "$dispatcher_id" ]] || { say "run.sh: --dispatcher-id is required"; usage; }
for command in "${gate_commands[@]}" ${review_commands[@]+"${review_commands[@]}"}; do
  [[ -n "${command//[[:space:]]/}" ]] || { say "run.sh: empty gate command"; exit 2; }
done
gate_json="$(printf '%s\0' "${gate_commands[@]}" | jq -Rs 'split("\u0000")[:-1]')"
review_json="$gate_json"
if (( ${#review_commands[@]} )); then
  review_json="$(printf '%s\0' "${review_commands[@]}" | jq -Rs 'split("\u0000")[:-1]')"
fi
jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and test("\\S"))' <<<"$test_command" >/dev/null || {
  say 'run.sh: --test-command must be a nonempty JSON argument array'; exit 2; }

[[ "$gate_timeout" =~ ^[1-9][0-9]*$ ]] || {
  say 'run.sh: --gate-timeout must be a positive integer'; exit 2; }
coder_args=()
if [[ -n "$coder_timeout" ]]; then
  coder_args=(--node-timeout "implement_code=$coder_timeout")
fi

# The host worker supplies a confirmed Task claim or an explicit finalization manifest.
claim_file="${LANE_CLAIM_FILE:-}"
[[ -f "$claim_file" ]] || {
  say "run.sh: confirmed host claim file required; start through the lane worker"; exit 2; }
jq -e -s --arg id "$ticket" --arg ws "$project" --arg finalize "${LANE_FINALIZE_ONLY:-false}" '
  length == 1 and (.[0] | .workspace == $ws and (.id | ascii_downcase) == ($id | ascii_downcase) and
    (if $finalize == "true" then .source == "joppa-finalization" and
      .delivery.input.finalizeOnly == true and .delivery.plan.final == true
     else .claimed == true and .status == "in_progress" end))
' "$claim_file" >/dev/null 2>&1 || {
  say "run.sh: confirmed host claim required; start through the lane worker"; exit 2; }

# Empty host mountpoints are shared by concurrent lane containers.
check_mountpoint() {
  local point="$TOOLING_ROOT/$(basename "$1")" entries
  if [[ -L "$point" || ( -e "$point" && ! -d "$point" ) ]]; then
    say "run.sh: $point is not an empty directory; refusing to hide it"
    return 2
  fi
  if [[ -d "$point" ]]; then
    entries="$(ls -A "$point")" || return 2
    if [[ -n "$entries" ]]; then
      say "run.sh: $point contains files; refusing to hide them"
      return 2
    fi
  fi
}
# The host worker starts every lane from a Joppa Task claim.
ticket_source=joppa
[[ "${LANE_SOURCE:-}" == joppa ]] || { say "run.sh: start through the Joppa lane worker"; exit 2; }
ticket_json="$(jq -ec '.ticket | select(.source == "joppa")' "$claim_file")"
# An explicit module asserts the ticket's module; it cannot replace it.
stored="$(jq -r '.module // empty' <<<"$ticket_json" 2>/dev/null || true)"
[[ -n "$stored" ]] || { say "run.sh: ticket $ticket declares no module; set it on the ticket"; exit 2; }
[[ -z "$module" || "$module" == "$stored" ]] || {
  say "run.sh: --module $module disagrees with ticket module $stored"; exit 2; }
module="$stored"

# The configured repository of the claimed Task; no fallback to another repository.
source_root="$(cd "$source_root" && pwd -P)"
repo="$(jq -er '.path' <<<"$LANE_REPOSITORY_JSON")"
repo="$(cd "$repo" && pwd -P)"
target="$(jq -er '.targetBranch' <<<"$LANE_REPOSITORY_JSON")"
repository_preflight="$(jq -r '.preflight // empty' <<<"$LANE_REPOSITORY_JSON")"
after_land="$(jq -r '.afterLand // empty' <<<"$LANE_REPOSITORY_JSON")"
worktree_root="${LANE_WORKTREE_ROOT:?Joppa needs worktreeRoot}"
[[ "$repo" == "$source_root" || "$repo" == "$source_root/"* ]] || {
  say 'run.sh: configured repository escapes sourceRoot'; exit 2; }
source_root_in="/workspace/$(basename "$source_root")"
if [[ "$repo" == "$source_root" ]]; then project_dir="$source_root_in";
else project_dir="$source_root_in/${repo#"$source_root/"}"; fi
worktree="$worktree_root/$ticket"
# Retained or foreign work must never be reset by a fresh dispatch.
[[ ! -L "$worktree_root" && ! -L "$worktree" ]] || {
  say "run.sh: worktree path is a symlink; startup refused"; exit 2; }
if [[ -e "$worktree" ]] && { [[ ! -d "$worktree" ]] || [[ -n "$(ls -A "$worktree")" ]]; }; then
  say "run.sh: WORKTREE PREEXISTED: $worktree; retained unchanged; inspect before retrying"; exit 73
fi
LANE_WORKTREE="/workspace/$ticket"

# Docker's medulla.runs_under label carries the stable dispatcher identity,
# including manual launches with --dispatcher-id.
RUNS_FOLDER="$(node "$TOOLING_ROOT/lane-launcher/scope.mjs" "$RUNS_FOLDER" "$dispatcher_id")"
mkdir -p "$RUNS_FOLDER"
# Resolve symlinks before passing the directory to Docker and to workflow nodes.
RUNS_FOLDER="$(cd "$RUNS_FOLDER" && pwd -P)"
say "run.sh: sources RO: $source_root"
say "run.sh: worktree RW: $worktree (private .git)"

mounts=(--mount "$source_root")
requirement_reader=""
if [[ -n "${LANE_REQUIREMENT_READER_DIR:-}" ]]; then
  mounts+=(--mount "$LANE_REQUIREMENT_READER_DIR")
  requirement_reader="/workspace/$(basename "$LANE_REQUIREMENT_READER_DIR")/token"
fi
node --input-type=module -e '
  import {pathToFileURL} from "node:url";
  const {validateWritableDirs} = await import(pathToFileURL(process.argv[1]));
  const [sourceRoot, sshDir, cbmCacheDir, ticket, sharedLockDir, ...dirs] = process.argv.slice(2);
  const split = dirs.indexOf("--");
  try { validateWritableDirs({sourceRoot, sshDir, cbmCacheDir,
    sharedLockDir: sharedLockDir || null, readOnlyRepos: dirs.slice(0, split), readWriteDirs: dirs.slice(split + 1)}, ticket); }
  catch (error) { console.error(`run.sh: ${error.message}`); process.exit(2); }
' "$TOOLING_ROOT/lane-launcher/runtime.mjs" "$source_root" "$ssh_dir" "$cbm_cache" "$ticket" "${shared_lock_dir:-}" \
  ${also[@]+"${also[@]}"} -- ${writable[@]+"${writable[@]}"}
if [[ -n "${shared_lock_dir:-}" ]]; then
  shared_lock_dir="$(cd "$shared_lock_dir" && pwd -P)"
  writable+=("$shared_lock_dir")
fi
for extra in ${also[@]+"${also[@]}"}; do
  [[ -d "$extra" ]] || { say "run.sh: --mount-ro is not a directory: $extra"; exit 2; }
  extra="$(cd "$extra" && pwd -P)"
  [[ "$extra" != "$source_root" && "$extra" != "$repo" ]] || continue
  check_mountpoint "$extra"
  mounts+=(--mount "$extra")
done

for extra in ${writable[@]+"${writable[@]}"}; do
  [[ "$extra" = /* && -d "$extra" ]] || { say "run.sh: --mount-rw needs an existing absolute directory: $extra"; exit 2; }
  extra="$(cd "$extra" && pwd -P)"
  check_mountpoint "$extra"
  mounts+=(--mount-rw "$extra")
done

git_ssh=""
# The Git key is visible to every node; prompt restrictions are not isolation.
if [[ -f "$ssh_dir/id_ed25519" ]]; then
  mounts+=(--mount "$ssh_dir")
  ssh_in="/workspace/$(basename "$ssh_dir")"
  git_ssh="ssh -F /dev/null -i $ssh_in/id_ed25519 -o IdentitiesOnly=yes"
  git_ssh+=" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$ssh_in/known_hosts"
else
  say "run.sh: no key at $ssh_dir/id_ed25519 - git fetch will fail at create_worktree"
  say "        put the lane's deploy key there (and nothing else), or pass --ssh-dir"
fi

source "$WORKFLOW_DIR/startup/cleanup.sh"
trap cleanup EXIT
for m in "$source_root" "$ssh_dir" ${also[@]+"${also[@]}"} ${writable[@]+"${writable[@]}"}; do
  point="$TOOLING_ROOT/$(basename "$m")"
  [[ " ${mounts[*]} " == *" $m "* ]] || continue
  check_mountpoint "$m"
  mkdir -p "$point"
done

export MEDULLA_IMAGE="$image"
if ! docker image inspect "$MEDULLA_IMAGE" >/dev/null; then
  say "run.sh: Docker image $MEDULLA_IMAGE is unavailable; startup refused."
  say "        Build the lane image from the Crew repository before retrying."
  exit 2
fi
export MEDULLA_BRIDGE="${MEDULLA_BRIDGE:-/tmp/medulla-bridge}"
mkdir -p "$MEDULLA_BRIDGE"
joppa_reader_command=""
if [[ -n "${LANE_JOPPA_MCP_COMMAND_JSON:-}" ]]; then
  joppa_connector_dir="$(mktemp -d "$MEDULLA_BRIDGE/joppa-connector.XXXXXX")"
  joppa_connector="$joppa_connector_dir/mcp.cjs"
  python3 "$WORKFLOW_DIR/bridge/cbm-connect.py" --joppa "$joppa_connector"
  joppa_reader_command="$(jq -cn --arg file "$joppa_connector" '["node", $file]')"
fi
unset LANE_JOPPA_MCP_COMMAND_JSON
cbm_connector="" cbm_project=""
equill_vars=()
if [[ "${LANE_FINALIZE_ONLY:-false}" != true ]]; then
  source "$WORKFLOW_DIR/startup/cbm.sh"
  source "$WORKFLOW_DIR/startup/equill.sh"
fi

# Code and Git writes use this ticket directory. Clone happens after claim.
check_mountpoint "$worktree"
mkdir -p "$(dirname "$worktree")" "$TOOLING_ROOT/$ticket"
worktree_created=false
if mkdir "$worktree" 2>/dev/null; then
  worktree_created=true
else
  say "run.sh: WORKTREE PREEXISTED: $worktree; retained unchanged; inspect before retrying"
  exit 73
fi
mounts+=(--mount-rw "$worktree")
cd "$TOOLING_ROOT"
# Joppa service credentials belong to the host worker, not lane agents.
unset JOPPA_TOKEN JOPPA_TOKEN_FILE
# Keep Crew's workflow, hooks and verification scripts read-only.
medulla \
  --docker \
  --cwd-ro \
  -w "${WORKFLOW_DIR#"$TOOLING_ROOT"/}" \
  --runs-folder "$RUNS_FOLDER" \
  ${coder_args[@]+"${coder_args[@]}"} \
  "${mounts[@]}" \
  --var "CBM_MCP_COMMAND=$cbm_connector" \
  --var "CBM_PROJECT=$cbm_project" \
  --var "ticket_id=$ticket" \
  --var "LAUNCH_CLAIM_FILE=$claim_file" \
  --var "TICKET_SOURCE=$ticket_source" \
  --var "TARGET_BRANCH=$target" \
  --var "REPOSITORY_PREFLIGHT=$repository_preflight" \
  --var "DELIVERY=${LANE_DELIVERY:-target}" \
  --var "DELIVERY_BRANCH=${LANE_DELIVERY_BRANCH:-}" \
  --var "REQUIREMENT_BRANCH=${LANE_REQUIREMENT_BRANCH:-}" \
  --var "REQUIREMENT_HEAD=${LANE_REQUIREMENT_HEAD:-}" \
  --var "REQUIREMENT_FINAL=${LANE_REQUIREMENT_FINAL:-false}" \
  --var "REQUIREMENT_READER_FILE=$requirement_reader" \
  --var "JOPPA_READER_COMMAND_JSON=$joppa_reader_command" \
  --var "FINALIZE_ONLY=${LANE_FINALIZE_ONLY:-false}" \
  --var "LANE_WORKTREE=$LANE_WORKTREE" \
  --var "ticket_title=$(jq -r '.title // empty' <<<"$ticket_json")" \
  --var "project_name=$project" \
  --var "project_dir=$project_dir" \
  --var "module_name=$module" \
  --var "gate_commands=$gate_json" \
  --var "review_commands=$review_json" \
  --var "gate_timeout_seconds=$gate_timeout" \
  --var "LANE_SHARED_LOCK_DIR=${shared_lock_dir:+/workspace/$(basename "$shared_lock_dir")}" \
  --var "ticket_test_command=$test_command" \
  --var "GIT_SSH_COMMAND=$git_ssh" \
  ${equill_vars[@]+"${equill_vars[@]}"} \
  ${passthrough[@]+"${passthrough[@]}"}
