#!/bin/sh
set -eu
if [ "${1:-}" = flush ]; then
  shift
  exec "${NODE_BIN:-node}" "$(dirname "$0")/../planning-joppa/flush.mjs" "$@"
fi
exec sh "$(dirname "$0")/planner-joppa.sh" "$@"
