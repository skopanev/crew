"""Read the Requirement of the claimed AC and its other ACs for the 11111+R audit. Reads only.

Usage: python3 context.py. Needs CREW_FLOW_STAGES and the flow environment of planning-joppa.
Writes artifacts/requirement.json: {requirement: {address, title, body}, siblings: [{address, title, body, tags}]}.
The publication fence does not cover these reads: a sibling edit during the audit does not stop publication.
"""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(os.environ["CREW_FLOW_STAGES"]).resolve().parent))
sys.path.insert(0, str(Path(os.environ["CREW_FLOW_STAGES"]).resolve().parents[1] / "planning"))
from flow_stages import artifacts, client, settings  # noqa: E402
from flow_context import pages  # noqa: E402
from context_reads import object_read  # noqa: E402


def main():
    target, config = artifacts(), settings()
    selected = json.loads((target / "input.json").read_text())["selected"]
    parent = selected["document"].get("parent")
    api = client(config)
    try:
        requirement = object_read(api, config["workspace"], parent) if parent else None
        siblings = [] if not parent else [
            {"address": row["address"], "title": row.get("title"), "body": row.get("body"), "tags": row.get("tags")}
            for row in pages(api, config["workspace"], {"kind": "ac", "parent": parent, "depth": 1,
                                                       "fields": ["title", "body", "tags"]})
            if row.get("address") != selected["address"]]
    finally:
        if api.stdio:
            api.stdio.close()
    data = (requirement or {}).get("document", {}).get("data", {})
    value = {"requirement": {"address": parent, "title": data.get("title"), "body": data.get("body")} if parent else None,
             "siblings": siblings}
    temp = target / "requirement.json.tmp"
    temp.write_text(json.dumps(value, ensure_ascii=False))
    temp.replace(target / "requirement.json")


if __name__ == "__main__":
    main()
