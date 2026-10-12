#!/usr/bin/env python3
"""Call Joppa on the host. Read credentials from files, never from arguments."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "planning-joppa"))
from mcp import Joppa, Rejected

try:
    request = json.load(sys.stdin)
    api = Joppa(request["url"], request["tokenFile"])
    result = api.call(request["tool"], request["arguments"])
    print(json.dumps({"result": result}))
except Exception as error:
    print(json.dumps({"error": str(error), "rejected": isinstance(error, Rejected)}))
    sys.exit(1)
