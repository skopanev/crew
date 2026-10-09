#!/usr/bin/env python3
"""Obtain a broker bridge for this lane's shared host CBM server."""
import os
import sys
from pathlib import Path

def prepare(command, source_root, cache_dir, output):
    sys.path.insert(0, str(Path.home() / ".local/lib/broker"))
    from broker.box.mcp import HOST_GATEWAY, _start_bridge
    from broker.box.shim import SHIM_TEMPLATE

    root = str(Path(source_root).resolve(strict=True))
    cache = str(Path(cache_dir).resolve(strict=True))
    # Resolve on EVERY start: a listener is collected after four idle hours.
    live = _start_bridge("codebase-memory", {"command": [command]},
                         {"mcp": {"codebase-memory": {"env": {
                             "CBM_ALLOWED_ROOT": root, "CBM_CACHE_DIR": cache}}}}, [root])
    if not live:
        raise RuntimeError("broker could not start the shared CBM bridge")
    body = SHIM_TEMPLATE % {"name": "codebase-memory", "host": HOST_GATEWAY,
                            "port": live["port"], "token": live["token"]}
    with open(output, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as file:
        file.write(body)
    print("run.sh: shared CBM bridge ready (broker)")


if __name__ == "__main__":
    try:
        prepare(*sys.argv[1:])
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(f"CBM bridge: {error}", file=sys.stderr)
        sys.exit(2)
