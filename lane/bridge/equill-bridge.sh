#!/usr/bin/env bash
set -uo pipefail
bridge="${MEDULLA_BRIDGE:-/tmp/medulla-bridge}/equill"
equill_bin="${EQUILL_BIN:-equill}"
poll="${EQUILL_BRIDGE_POLL:-0.1}"
export EQUILL_ACTOR=lane

# Host identity is fixed here; the caller's actor/env never crosses the bridge.
# Only the two read operations needed by lane contracts and memory are exposed.
allowed_verbs="context search"

command -v "$equill_bin" >/dev/null 2>&1 || { echo "equill-bridge: no equill on PATH" >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "equill-bridge: no jq on PATH" >&2; exit 127; }
mkdir -p "$bridge/req" "$bridge/resp" || exit 1
chmod 700 "$bridge" "$bridge/req" "$bridge/resp" 2>/dev/null || true

# The operating system releases this lock when the bridge exits.
if [ "${1:-}" != --locked ]; then
  exec python3 - "$0" "$bridge" <<'PY'
import fcntl
from pathlib import Path
import subprocess
import sys

lock = (Path(sys.argv[2]) / "bridge.lock").open("a")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)
sys.exit(subprocess.call(["/bin/bash", sys.argv[1], "--locked"]))
PY
fi

pidfile="$bridge/bridge.pid"
if [ -f "$pidfile" ]; then
  old="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "equill-bridge: already running (pid $old)" >&2
    exit 0
  fi
fi
printf 'lane:%s\n' "$$" > "$bridge/bridge.identity"
echo $$ > "$pidfile"
trap 'rm -f "$pidfile" "$bridge/bridge.identity"; exit 0' INT TERM HUP

echo "equill-bridge listening on $bridge (pid $$)"

while true; do
  found=0
  for req in "$bridge"/req/*.json; do
    [ -e "$req" ] || continue
    found=1
    id="$(basename "$req" .json)"

    argv=()
    while IFS= read -r b64; do argv+=("$(printf %s "$b64" | base64 -d)"); done \
      < <(jq -r '.argv[]? | @base64' "$req" 2>/dev/null)
    rm -f "$req"

    # What was actually asked, not just which verb. A --query is the whole point
    # of the call; coordinates are what a baseline asks by instead.
    ask=""; take=""
    for a in "${argv[@]}"; do
      # equill takes --coordinate SEPARATED from its value, so the value is the
      # NEXT argument, not part of this one. The first version only handled the
      # attached --query=... form and logged a baseline as an empty request.
      case "$take" in
        coord) ask="${ask:+$ask }[$a]"; take="" ; continue ;;
        prof)  ask="${ask:+$ask }<$a>"; take="" ; continue ;;
      esac
      case "$a" in
        --query=*)   ask="${a#--query=}" ;;
        --coordinate) take=coord ;;
        --profile)   take=prof ;;
      esac
    done
    printf '%s %-8s request: "%s"\n' "$(date +%H:%M:%S)" "${argv[0]:-?}" "${ask:0:220}"
    out="$bridge/resp/$id.out"; err="$bridge/resp/$id.err"; rc_f="$bridge/resp/$id.rc"
    if [ ${#argv[@]} -eq 0 ]; then
      : > "$out"; echo "equill-bridge: empty argv" > "$err"; printf '2' > "$rc_f.tmp"
    elif ! printf '%s\n' $allowed_verbs | grep -qxF -- "${argv[0]}"; then
      : > "$out"
      echo "equill-bridge: refused verb '${argv[0]}' (this bridge is read-only)" > "$err"
      printf '2' > "$rc_f.tmp"
    else
      "$equill_bin" "${argv[@]}" > "$out" 2> "$err"
      printf '%s' "$?" > "$rc_f.tmp"
    fi

    mv -f "$rc_f.tmp" "$rc_f"
  done
  [ "$found" -eq 1 ] || sleep "$poll"
done
