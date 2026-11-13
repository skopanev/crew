# Sourced by lane/run.sh: shared CBM connector and source sync. Uses run.sh variables.
# Broker supplies a current bridge, scoped to this source root, as for --box.
# Only its small per-run connector enters the container; the database stays shared.
cbm_connector_dir="$(mktemp -d "$MEDULLA_BRIDGE/cbm-connector.XXXXXX")"
cbm_connector="$cbm_connector_dir/mcp.py"
python3 "$WORKFLOW_DIR/bridge/cbm-connect.py" "$cbm_command" "$source_root" "$cbm_cache" "$cbm_connector"
chmod 600 "$cbm_connector"
cbm_project="$(jq -er '.cbmProject' <<<"$LANE_REPOSITORY_JSON")"
# Read-only Medulla checks do not update canonical sources or CBM.
sync_sources=true
for arg in ${passthrough[@]+"${passthrough[@]}"}; do
  case "$arg" in --dry-run|--validate|--graph) sync_sources=false ;; esac
done
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
