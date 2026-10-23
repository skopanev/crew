#!/usr/bin/env python3
"""Obtain broker connectors for this lane's host MCP servers."""
import json
import os
import sys
from pathlib import Path

def prepare(command, source_root, cache_dir, output):
    sys.path.insert(0, str(Path.home() / ".local/lib/broker"))
    from broker.box import connect_mcp

    root = str(Path(source_root).resolve(strict=True))
    cache = str(Path(cache_dir).resolve(strict=True))
    # Resolve on EVERY start: a listener is collected after four idle hours.
    connect_mcp("codebase-memory", [command], output,
                env={"CBM_ALLOWED_ROOT": root, "CBM_CACHE_DIR": cache}, roots=[root])
    print("run.sh: shared CBM bridge ready (broker)")


def prepare_joppa(output):
    sys.path.insert(0, str(Path.home() / ".local/lib/broker"))
    from broker.box import connect_mcp
    command = json.loads(os.environ["LANE_JOPPA_MCP_COMMAND_JSON"])
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) and arg for arg in command):
        raise ValueError("Joppa MCP command needs executable arguments")
    connect_mcp("joppa", command, output, lang="js")
    print("run.sh: shared Joppa reader ready (broker)")


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--joppa":
            prepare_joppa(sys.argv[2])
        else:
            prepare(*sys.argv[1:])
    except (ImportError, LookupError, OSError, ValueError, RuntimeError) as error:
        print(f"MCP bridge: failed: {error}", file=sys.stderr)
        sys.exit(2)
