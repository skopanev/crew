#!/bin/sh
set -eu
exec "${PLANNING_PYTHON:-python3}" "$(dirname "$0")/launch.py" "$@"
