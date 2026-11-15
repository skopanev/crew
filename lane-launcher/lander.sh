#!/bin/sh
set -eu
exec sh "$(dirname "$0")/planner-joppa.sh" "$@"
