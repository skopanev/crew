"""Apply the configured Node admission module before a flow claims its inputs."""
import json
import os
from pathlib import Path
import subprocess
import sys

from common import require


def admitted_rows(config, rows, full=False):
    if "admission_module" not in config:
        return rows
    result = subprocess.run([os.environ.get("NODE_BIN", "node"),
                             str(Path(__file__).with_name("configured-admission.mjs"))],
                            input=json.dumps({"config": config, "rows": rows, "full": full}),
                            text=True, capture_output=True, timeout=30)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    require(result.returncode == 0, "configured admission failed: " + result.stderr.strip()[:300])
    addresses = json.loads(result.stdout)
    require(isinstance(addresses, list) and all(isinstance(value, str) for value in addresses) and
            set(addresses) <= {row["address"] for row in rows}, "invalid configured admission response")
    return [row for row in rows if row["address"] in addresses]
