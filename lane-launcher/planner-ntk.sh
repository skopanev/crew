#!/bin/sh
set -eu
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/../planning-ntk/dispatch.mjs" "$@"
