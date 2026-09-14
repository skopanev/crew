#!/usr/bin/env bash
set -euo pipefail
# Builds the lane image, handing it the HOST harness versions so it can take
# whichever is newer. Read here rather than in the Dockerfile, because a build
# cannot see the host.
cd "$(dirname "${BASH_SOURCE[0]}")"
v() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
docker build -t "${MEDULLA_IMAGE:-medulla-crew:latest}" -f Dockerfile \
  --build-arg "CLAUDE_HOST_VERSION=$(v claude)" \
  --build-arg "CODEX_HOST_VERSION=$(v codex)" \
  "$@" .
