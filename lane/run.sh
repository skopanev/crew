#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat >&2 <<'USAGE'
usage: run.sh --ticket-id <id> --project <ntk workspace> --source-root <workspace>
              --dispatcher-id <dolber id>
              --cbm-mcp-command <file> --cbm-cache-dir <shared-store>
              --gate-command <shell command> [...]
              --test-command '["runner", "args"]'
              [--module <module>]
              [--mount-ro <repo>]... [--mount-rw <dir>]... [--ssh-dir <dir>]
              [--image <image>] [--docker-engine] [--land-mode direct|train] [--train-gates-only]
              [--lane-setup <shell command>]
              [--planning-result <result.json> --planning-task <task-id>]
              [extra medulla args...]

  --source-root  entire source workspace, mounted read-only. The ticket module
                 names the source repository within it.
  --cbm-mcp-command  native host CBM executable; broker bridges it for this lane.
              The lane uses that service; it never copies or indexes a database.
  --cbm-cache-dir  existing shared CBM store, the same as the active daemon uses.
  --module    ticket module; read from ntk when omitted
  --image     lane runtime image; defaults to medulla-crew:latest
  --docker-engine  enable the broker box's private Docker engine for tests
  --dispatcher-id  stable Dolber ID; manual lanes use the same ID to share its limit.
  --planning-result  completed planning receipt; requires a fresh live Joppa
                     chain and age below 24h before this lane may start.
  --planning-task    local Task id in that plan; repository/module must match.
  --gate-command  required check, run from the candidate repo root. Repeatable.
                  Supplied by the operator; no commands are inferred from code.
  --test-command  required runner argument array for existing-code verification.
  --lane-setup  optional project-owned shell command run inside the lane after
                checkout (for example to seed a private build cache).
  --mount-ro  another repository to mount READ-ONLY, for scope. Repeatable.
  --mount-rw  an existing directory to mount writable at /workspace/<name>. Repeatable.
  --ssh-dir  directory holding ONLY the lane's git key, as id_ed25519, plus an
             optional known_hosts. No default: landing needs a key and a
             made-up path that nobody created is worse than none. The whole
             directory is what the agent can read, so nothing else belongs in it.

Anything after the known flags is passed to medulla unchanged, so --validate,
--dry-run, --resume and --node work as usual.
USAGE
  exit 2
}

WORKFLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Herdr panes need explicit CRLF for shell messages.
say() { printf '%s\r\n' "$*" >&2; }
RUNS_FOLDER="${LANE_RUNS_FOLDER:-$HOME/.medulla/lane-runs}"
TOOLING_ROOT="$(cd "$WORKFLOW_DIR/.." && pwd)"

ticket="" project="" source_root="" module="" ssh_dir="${LANE_SSH_DIR:-}" cbm_command="" cbm_cache="" dispatcher_id=""
planning_result="" planning_task="" image="${MEDULLA_IMAGE:-medulla-crew:latest}" land_mode="direct" train_gates_only=false lane_setup=""
test_command='[]'
also=()
writable=()
gate_commands=()
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
    --planning-result) planning_result="${2:-}"; shift 2 ;;
    --planning-task) planning_task="${2:-}"; shift 2 ;;
    --runs-folder|--runs-folder=*) say "run.sh: use LANE_RUNS_FOLDER; dispatcher identity must remain in the run path"; exit 2 ;;
    --mount-ro) also+=("${2:-}"); shift 2 ;;
    --mount-rw) writable+=("${2:-}"); shift 2 ;;
    --ssh-dir) ssh_dir="${2:-}"; shift 2 ;;
    --cbm-mcp-command) cbm_command="${2:-}"; shift 2 ;;
    --cbm-cache-dir) cbm_cache="${2:-}"; shift 2 ;;
    --gate-command) gate_commands+=("${2:-}"); shift 2 ;;
    --test-command) test_command="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    --land-mode) land_mode="${2:-}"; shift 2 ;;
    --train-gates-only) train_gates_only=true; shift ;;
    --lane-setup) lane_setup="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) passthrough+=("$1"); shift ;;
  esac
done
if [[ -n "$planning_result" || -n "$planning_task" ]]; then
  [[ -n "$planning_result" && -n "$planning_task" ]] || {
    say "run.sh: --planning-result and --planning-task must be supplied together"; exit 2; }
  planning_result="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$planning_result")"
fi
[[ -n "$ticket"  ]] || { say "run.sh: --ticket-id is required"; usage; }
[[ -n "$project" ]] || { say "run.sh: --project is required"; usage; }
[[ -n "$source_root" ]] || { say "run.sh: --source-root is required"; usage; }
[[ "$land_mode" == direct || "$land_mode" == train ]] || { say "run.sh: --land-mode must be direct or train"; usage; }
# Deferring every check to the train is only sound when the train runs them.
if $train_gates_only && [[ "$land_mode" != train ]]; then
  say "run.sh: --train-gates-only requires --land-mode train"; exit 2
fi
[[ "$ticket" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { say "run.sh: invalid ticket id"; exit 2; }
[[ -x "$cbm_command" ]] || { say "run.sh: --cbm-mcp-command must name an executable host CBM server"; exit 2; }
[[ -n "$cbm_cache" && -d "$cbm_cache" ]] || { say "run.sh: --cbm-cache-dir must name the existing shared CBM store"; exit 2; }
(( ${#gate_commands[@]} )) || { say "run.sh: --gate-command is required"; usage; }
[[ -n "$dispatcher_id" ]] || { say "run.sh: --dispatcher-id is required"; usage; }
for command in "${gate_commands[@]}"; do
  [[ -n "${command//[[:space:]]/}" ]] || { say "run.sh: empty gate command"; exit 2; }
done
gate_json="$(printf '%s\0' "${gate_commands[@]}" | jq -Rs 'split("\u0000")[:-1]')"
jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and test("\\S"))' <<<"$test_command" >/dev/null || {
  say 'run.sh: --test-command must be a nonempty JSON argument array'; exit 2; }

# The host worker owns NTK claims; no Docker or preflight without its receipt.
jq -e -s --arg id "$ticket" --arg ws "$project" '
  length == 1 and (.[0] | .claimed == true and .status == "in_progress" and
    .workspace == $ws and (.id | ascii_downcase) == ($id | ascii_downcase))
' <<<"${LANE_CLAIM_JSON:-}" >/dev/null 2>&1 || {
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
if ! ticket_json="$(node --input-type=module -e '
  import {pathToFileURL} from "node:url";
  const {getTicket} = await import(pathToFileURL(process.argv[1]));
  try { console.log(JSON.stringify(await getTicket(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(error.message); process.exit(1); }
' "$TOOLING_ROOT/lane-launcher/ntk.mjs" "$ticket" "$project" 2>&1)"; then
  say "run.sh: ${ticket_json%%$'\n'*}"
  say "run.sh: ticket $ticket does not exist in workspace $project - nothing to run"
  exit 2
fi
# An explicit module asserts the ticket's module; it cannot replace it.
stored="$(jq -r '.module // empty' <<<"$ticket_json" 2>/dev/null || true)"
[[ -n "$stored" ]] || { say "run.sh: ticket $ticket declares no module; set it on the ticket"; exit 2; }
[[ -z "$module" || "$module" == "$stored" ]] || {
  say "run.sh: --module $module disagrees with ticket module $stored"; exit 2; }
module="$stored"

# The ticket declares its repository as the first component of its module.
# No project filter, repository map or fallback to a different repository.
source_root="$(cd "$source_root" && pwd -P)"
component="${module%%/*}"
[[ -n "$component" && "$component" != . && "$component" != .. ]] || {
  say "run.sh: module must name a repository or repository/path inside --source-root"; exit 2; }
repo="$source_root/$component"
[[ -d "$repo/.git" ]] || { say "run.sh: ticket module has no source checkout: $repo"; exit 2; }
repo="$(cd "$repo" && pwd -P)"
[[ "$repo" == "$source_root/"* ]] || { say "run.sh: module escapes --source-root"; exit 2; }
# Landing targets come only from the repository's .ntkrc; there is no default.
target="$(jq -er '.target_branch | select(type == "string" and length > 0)' "$repo/.ntkrc" 2>/dev/null)" \
  && [[ "$target" != -* && "$target" != HEAD ]] && git check-ref-format "refs/heads/$target" || {
  say "run.sh: $repo/.ntkrc must set target_branch to a legal branch name"; exit 2; }
source_root_in="/workspace/$(basename "$source_root")"
project_dir="$source_root_in/${repo#"$source_root/"}"
worktree="$source_root/.worktrees/$ticket"
# Retained or foreign work must never be reset by a fresh dispatch.
[[ ! -L "$source_root/.worktrees" && ! -L "$worktree" ]] || {
  say "run.sh: worktree path is a symlink; startup refused"; exit 2; }
if [[ -e "$worktree" ]] && { [[ ! -d "$worktree" ]] || [[ -n "$(ls -A "$worktree")" ]]; }; then
  say "run.sh: WORKTREE PREEXISTED: $worktree; retained unchanged; inspect before retrying"; exit 73
fi
LANE_WORKTREE="/workspace/$ticket"

planning_admission() {
  [[ -n "$planning_result" ]] || return 0
  python3 "$TOOLING_ROOT/planning/admit.py" --result "$planning_result" \
    --task "$planning_task" --repository "$repo" --module "$module"
}
# Reject stale plans before container/index preparation. Check again immediately
# before Medulla, since setup itself can cross the expiry boundary.
planning_admission

# Docker's medulla.runs_under label carries the stable dispatcher identity,
# including manual launches with --dispatcher-id.
RUNS_FOLDER="$(node "$TOOLING_ROOT/lane-launcher/scope.mjs" "$RUNS_FOLDER" "$dispatcher_id")"
mkdir -p "$RUNS_FOLDER"
# Resolve symlinks before passing the directory to Docker and to workflow nodes.
RUNS_FOLDER="$(cd "$RUNS_FOLDER" && pwd -P)"
say "run.sh: sources RO: $source_root"
say "run.sh: worktree RW: $worktree (private .git)"

mounts=(--mount "$source_root")
node --input-type=module -e '
  import {pathToFileURL} from "node:url";
  const {validateWritableDirs} = await import(pathToFileURL(process.argv[1]));
  const [sourceRoot, sshDir, cbmCacheDir, ticket, ...dirs] = process.argv.slice(2);
  const split = dirs.indexOf("--");
  try { validateWritableDirs({sourceRoot, sshDir, cbmCacheDir,
    readOnlyRepos: dirs.slice(0, split), readWriteDirs: dirs.slice(split + 1)}, ticket); }
  catch (error) { console.error(`run.sh: ${error.message}`); process.exit(2); }
' "$TOOLING_ROOT/lane-launcher/runtime.mjs" "$source_root" "$ssh_dir" "$cbm_cache" "$ticket" \
  ${also[@]+"${also[@]}"} -- ${writable[@]+"${writable[@]}"}
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

cleanup() {
  local code=$? base head changes target
  if [[ "${worktree_created:-false}" == true && -d "$worktree" && ! -L "$worktree" ]]; then
    if [[ -z "$(ls -A "$worktree")" ]]; then
      rmdir "$worktree" && printf 'run.sh: removed unused worktree: %s\r\n' "$worktree"
    elif [[ "$code" -eq 0 ]]; then
      if target="$(jq -er '.target_branch | select(type == "string" and length > 0)' "$worktree/.ntkrc" 2>/dev/null)" \
        && changes="$(git --no-optional-locks -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null)" \
        && [[ -z "$changes" ]] \
        && git -C "$worktree" merge-base --is-ancestor HEAD "refs/remotes/origin/$target"; then
        if rm -rf -- "$worktree"; then
          printf 'run.sh: removed completed worktree: %s\r\n' "$worktree"
        else
          say "run.sh: cannot remove completed worktree: $worktree" >&2
        fi
      else
        say "run.sh: retained worktree: clean landed state not confirmed at $worktree" >&2
      fi
    elif [[ -d "$worktree/.git" && -f "$worktree/.git/lane-base" ]]; then
      if base="$(cat "$worktree/.git/lane-base" 2>/dev/null)" \
        && head="$(git --no-optional-locks -C "$worktree" rev-parse HEAD 2>/dev/null)" \
        && changes="$(git --no-optional-locks -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null)" \
        && [[ -n "$base" && "$head" == "$base" && -z "$changes" ]]; then
        if rm -rf -- "$worktree"; then
          printf 'run.sh: removed unchanged worktree: %s\r\n' "$worktree"
        fi
      fi
    fi
  fi
  [[ -z "${cbm_connector_dir:-}" ]] || rm -rf "$cbm_connector_dir"
  return "$code"
}
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

# Broker supplies a current bridge, scoped to this source root, as for --box.
# Only its small per-run connector enters the container; the database stays shared.
cbm_connector_dir="$(mktemp -d "$MEDULLA_BRIDGE/cbm-connector.XXXXXX")"
cbm_connector="$cbm_connector_dir/mcp.py"
python3 "$WORKFLOW_DIR/bridge/cbm-connect.py" "$cbm_command" "$source_root" "$cbm_cache" "$cbm_connector"
chmod 600 "$cbm_connector"
cbm_project="$(printf %s "$repo" | sed 's|^/||; s|/|-|g')"
# Read-only Medulla checks do not update canonical sources or CBM.
sync_sources=true
for arg in ${passthrough[@]+"${passthrough[@]}"}; do
  case "$arg" in --dry-run|--validate|--graph) sync_sources=false ;; esac
done
# Stop before any sync or Docker work when this machine's Equill store lags the
# committed role snapshots: export is one-way, so git pull alone never updates it.
if $sync_sources && [[ -z "${CREW_SKIP_ROLE_CHECK:-}" && -f "$TOOLING_ROOT/roles/export.py" ]]; then
  EQUILL_STORE="${EQUILL_STORE:-$HOME/.equill/dev}" \
    python3 "$TOOLING_ROOT/roles/export.py" --check lane shared || exit 2
fi
if $sync_sources; then
  python3 "$TOOLING_ROOT/lane-launcher/safe-sync.py" "$source_root" "$cbm_connector" "$MEDULLA_IMAGE"
else
  docker run --rm --entrypoint python3 \
    --add-host=host.docker.internal:host-gateway \
    -v "$cbm_connector_dir:$cbm_connector_dir:ro" \
    -v "$WORKFLOW_DIR/bridge/cbm-probe.py:/tmp/cbm-probe.py:ro" \
    "$MEDULLA_IMAGE" /tmp/cbm-probe.py "$cbm_connector" "$cbm_project"
fi
say "run.sh: shared codebase memory connected"

bridge_dir="$MEDULLA_BRIDGE/equill"
mkdir -p "$bridge_dir/req" "$bridge_dir/resp"
if [[ ! -f "$bridge_dir/bridge.pid" ]] || ! kill -0 "$(cat "$bridge_dir/bridge.pid" 2>/dev/null)" 2>/dev/null; then
  nohup bash "$WORKFLOW_DIR/bridge/equill-bridge.sh" >>"$MEDULLA_BRIDGE/equill-bridge.log" 2>&1 &
  disown || true
fi

for ((bridge_attempt=0; bridge_attempt<25; bridge_attempt++)); do
  bridge_pid="$(cat "$bridge_dir/bridge.pid" 2>/dev/null || true)"
  if [[ -n "$bridge_pid" ]] && kill -0 "$bridge_pid" 2>/dev/null \
     && [[ "$(cat "$bridge_dir/bridge.identity" 2>/dev/null || true)" == "lane:$bridge_pid" ]]; then
    break
  fi
  sleep 0.2
done

# An already-running old bridge may still inherit its owner's write identity.
# Do not reuse it silently or stop it while another caller might be using it.
bridge_pid="$(cat "$bridge_dir/bridge.pid" 2>/dev/null || true)"
if [[ -z "$bridge_pid" ]] || ! kill -0 "$bridge_pid" 2>/dev/null \
   || [[ "$(cat "$bridge_dir/bridge.identity" 2>/dev/null || true)" != "lane:$bridge_pid" ]]; then
  say "run.sh: Equill bridge is unavailable or predates the fixed lane identity."
  say "        Stop the old bridge when unused, then retry; startup refused."
  exit 2
fi

equill_vars=(
    --var "EQUILL_STORE=${EQUILL_STORE:-$HOME/.equill/dev}"
    --var "EQUILL_ACTOR=lane"
    --var "EQUILL_BRIDGE=$bridge_dir"
    --var "EQUILL_MEMORY_ROLE=lane"
    --var "EQUILL_RULES=${EQUILL_RULES:-none}"
    --var "EQUILL_SESSION_PROFILE=${EQUILL_SESSION_PROFILE:-agent.context.target}"
    --var "EQUILL_PROMPT_PROFILE=${EQUILL_PROMPT_PROFILE:-agent.memory.hybrid}"
    --var "LANE_WORKTREE=$LANE_WORKTREE"
    --var "EQUILL_PROJECT=$project"
    --var "EQUILL_TICKET=$ticket"
    --var "EQUILL_MODULE=$module"
    --var "EQUILL_PM=${LANE_PM_ALIAS:-${project}-pm}"
    --var "LAND_MODE=$land_mode"
    --var "LANE_SETUP=$lane_setup"
)
if $train_gates_only; then
  equill_vars+=(
    --var "TRAIN_GATES_ONLY=true"
    --var "GATES_NOTE_CODER=Checks are deferred to the landing train: they run later on the integrated tree. Add or update the tests and checks this ticket needs, but do not run builds, test suites or gate commands in this lane. The train runs the configured gates and the ticket acceptance checks. List any further check commands the train must run in coder-checks.json in the Artifacts directory, as a JSON list of shell command strings run from the repository root; write [] when there are none."
    --var "GATES_NOTE_QA=Checks are deferred to the landing train and PENDING; none ran in this lane. Review the code provisionally. Never state or imply that any check passed. Name missing tests as findings."
  )
fi
say "run.sh: memory on (equill bridge pid $bridge_pid)"

# Code and Git writes use this ticket directory. Clone happens after claim.
check_mountpoint "$worktree"
mkdir -p "$(dirname "$worktree")" "$TOOLING_ROOT/$ticket"
worktree_created=false
if mkdir "$worktree" 2>/dev/null; then
  worktree_created=true
elif [[ ! -d "$worktree" || -L "$worktree" || -n "$(ls -A "$worktree")" ]]; then
  say "run.sh: WORKTREE PREEXISTED: $worktree; retained unchanged; inspect before retrying"
  exit 73
else
  # This run owns the accepted empty directory.
  worktree_created=true
fi
mounts+=(--mount-rw "$worktree")
cd "$TOOLING_ROOT"
planning_admission
# Admission's service identity belongs to the host check, not lane agents.
unset JOPPA_TOKEN JOPPA_TOKEN_FILE
# Keep Crew's workflow, hooks and verification scripts read-only.
medulla \
  --docker \
  --cwd-ro \
  -w "${WORKFLOW_DIR#"$TOOLING_ROOT"/}" \
  --runs-folder "$RUNS_FOLDER" \
  "${mounts[@]}" \
  --var "CBM_MCP_COMMAND=$cbm_connector" \
  --var "CBM_PROJECT=$cbm_project" \
  --var "ticket_id=$ticket" \
  --var "LAUNCH_CLAIM=${LANE_CLAIM_JSON:-}" \
  --var "ticket_title=$(jq -r '.title // empty' <<<"$ticket_json")" \
  --var "project_name=$project" \
  --var "project_dir=$project_dir" \
  --var "module_name=$module" \
  --var "repository=${repo#"$source_root/"}" \
  --var "gate_commands=$gate_json" \
  --var "ticket_test_command=$test_command" \
  --var "GIT_SSH_COMMAND=$git_ssh" \
  ${equill_vars[@]+"${equill_vars[@]}"} \
  ${passthrough[@]+"${passthrough[@]}"}
