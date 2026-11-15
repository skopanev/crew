# Sourced by lane/run.sh. Source freshness remains mandatory when CBM is optional.
cbm_optional=false
[[ "${LANE_CBM_REQUIRED:-true}" != false ]] || cbm_optional=true
cbm_ready=true
cbm_connector_dir="$(mktemp -d "$MEDULLA_BRIDGE/cbm-connector.XXXXXX")"
if ! cbm_connector="$(python3 "$WORKFLOW_DIR/bridge/cbm-connect.py" "$cbm_command" "$source_root" "$cbm_cache" "$cbm_connector_dir/mcp.py")" || [[ ! -f "$cbm_connector" ]]; then
  if ! $cbm_optional; then say 'run.sh: broker returned no CBM connector'; exit 2; fi
  cbm_connector=""
fi
cbm_project="$(jq -er '.cbmProject' <<<"$LANE_REPOSITORY_JSON")"
sync_sources=true
for arg in ${passthrough[@]+"${passthrough[@]}"}; do
  case "$arg" in --dry-run|--validate|--graph) sync_sources=false ;; esac
done
if $sync_sources; then
  if python3 "$TOOLING_ROOT/lane-launcher/safe-sync.py" "$source_root" "$cbm_connector" "$MEDULLA_IMAGE"; then
    cbm_ready=true
  else
    status=$?
    if $cbm_optional && [[ "$status" = 76 ]]; then cbm_ready=false; else exit "$status"; fi
  fi
elif [[ -z "$cbm_connector" ]]; then
  cbm_ready=false
elif ! docker run --rm --entrypoint python3 \
    --add-host=host.docker.internal:host-gateway \
    -v "$cbm_connector_dir:$cbm_connector_dir:ro" \
    -v "$WORKFLOW_DIR/bridge/cbm-probe.py:/tmp/cbm-probe.py:ro" \
    "$MEDULLA_IMAGE" /tmp/cbm-probe.py "$cbm_connector" "$cbm_project"; then
  if ! $cbm_optional; then exit 2; fi
  cbm_ready=false
fi
if $cbm_ready; then
  say 'run.sh: shared codebase memory connected'
else
  cbm_connector="" cbm_project=""
  say 'run.sh: optional CBM unavailable. Continue with source search and file reads.'
fi
