# Sourced by lane/run.sh: Equill bridge startup and lane memory variables. Uses run.sh variables.
bridge_dir="$MEDULLA_BRIDGE/equill"
mkdir -p "$bridge_dir/req" "$bridge_dir/resp"
if [[ ! -f "$bridge_dir/bridge.pid" ]] || ! kill -0 "$(cat "$bridge_dir/bridge.pid" 2>/dev/null)" 2>/dev/null; then
  # The bridge is shared by every lane, so it must not live in this lane's
  # process group: the lane worker signals that group on exit. A new session
  # (setsid(2) via Python, portable to macOS without a setsid binary) detaches
  # it; stdin is /dev/null and output goes to the shared log. The bridge's own
  # flock keeps concurrent starts down to one bridge.
  python3 -c '
import subprocess, sys
with open(sys.argv[2], "ab") as log:
    subprocess.Popen(["bash", sys.argv[1]], stdin=subprocess.DEVNULL, stdout=log,
                     stderr=log, start_new_session=True, close_fds=True)
' "$WORKFLOW_DIR/bridge/equill-bridge.sh" "$MEDULLA_BRIDGE/equill-bridge.log"
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
    --var "EQUILL_PROJECT=$project"
    --var "EQUILL_TICKET=$ticket"
    --var "EQUILL_MODULE=$module"
    --var "EQUILL_PM=${LANE_PM_ALIAS:-${project}-pm}"
)
say "run.sh: memory on (equill bridge pid $bridge_pid)"
