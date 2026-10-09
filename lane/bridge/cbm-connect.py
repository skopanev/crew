#!/usr/bin/env python3
"""Obtain a broker bridge for this lane's shared host CBM server."""
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


if __name__ == "__main__":
    try:
        prepare(*sys.argv[1:])
    except (ImportError, LookupError, OSError, ValueError, RuntimeError) as error:
        print(f"CBM bridge: {error}", file=sys.stderr)
        sys.exit(2)
