"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
from common import read
import context
from mcp import MCPError, Rejected, Reader
import publication



def item(address, parent=None, data=None, process=None, role=None):
    return {"address": address, "kind": address.split(":")[0], "id": address.split(":")[1],
            "current_revision": 3, "document": {"present": True, "data": data or {"title": address, "owner": "owner"},
             "parent": parent, "links": [], "revision": 3, "actor": "document-owner", "position": 10},
            "process": process or {}, "annotations": {"comments": []}, "files": [], "references": [],
            "position": 20, "historical": False, "work_ready": True,
            "status": {"tone": "orange", "label": "No tests"}}

CHECK_TYPE = {"role": "test", "parents": ["criterion"], "title_max_length": 400}

def assignment():
    task = context.source(item("work:old", "criterion:a", {"title": "Existing", "owner": "document-owner",
        "body": "Existing contract", "projects": ["other"], "custom": "preserve"},
        {}))
    task["document"]["links"] = [{"target": "record:note", "relation": "related", "revision": 3, "blocking": False}]
    ac = context.source(item("criterion:a", "rule:r"))
    dependency = context.source(item("work:dependency", "criterion:b"))
    return {"workspace": "example", "ac": {"id": "criterion:a"},
            "repositories": [{"id": "service", "project": "project:p", "path": "/tmp/example-source",
                              "cbm_project": "service", "modules": [{"name": "core", "path": "src"}]}],
            "joppa": {"task_type": "work", "task_schema": {"question": "What work?", "title_preview_length": 64},
                      "tasks": [task], "objects": {"criterion:a": ac, "work:old": task, "work:dependency": dependency},
                      "test_nodes": [], "test_type": "check",
                      "test_schema": {"role": "test", "parents": ["criterion"], "title_max_length": 400},
                      "test_rules": {"max_tests": 200, "name": {"separator": " > ", "min_parts": 2,
                                                                "max_length": 400, "file_extension": True}}}}

def plan():
    task = {"id": "first", "action": "create", "ac": "criterion:a", "title": "Create a mechanism",
            "repository": "service", "module": "core", "outcome": "Observable output",
            "steps": ["Use the existing mechanism and reject invalid input."], "reuse": ["Existing mechanism"],
            "depends_on": [], "checks": [{"scenario": "Reject invalid input", "expected": "No mutation"}]}
    return {"disposition": "implement", "outcome": "Criterion output", "necessity": "Required work",
            "approach": "Use the existing mechanism", "rationale": "Minimum sufficient scope",
            "alternatives": ["Existing behavior does not supply the output"], "blockers": [],
            "acceptance_checks": [{"repository": "service", **deepcopy(task["checks"][0])}],
            "tasks": [task]}

class Fake:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if self.error:
            raise self.error
        return self.result

class NodeServer:
    """Serve test node list pages of 25 and single-node details."""
    def __init__(self, nodes=None):
        self.nodes, self.calls = dict(nodes or {}), []

    def add(self, address, parent, title, status="green", result=None, revision=1, ancestor="rule:r"):
        self.nodes[address] = {"parent": parent, "title": title, "status": status, "result": result,
                               "revision": revision, "ancestor": ancestor}

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        assert name == "joppa_objects", name
        if args.get("address"):
            addresses = args["address"].split(",")
            assert len(addresses) <= 25, "more than 25 addresses are refused"
            items = [{"address": address, "data": {"title": node["title"]}, "parent": node["parent"],
                      "revision": node["revision"], "status": {"tone": node["status"], "label": node["status"]},
                      **({"result": deepcopy(node["result"])} if node["result"] else {})}
                     for address in addresses for node in [self.nodes[address]]]
            return items[0] if len(items) == 1 else {"items": items}
        rows = sorted((address, node) for address, node in self.nodes.items()
                      if args["parent"] in ("*", node["parent"], node["ancestor"]) and args.get("kind") == "check")
        rows = [row for row in rows if not args.get("cursor") or row[0] > args["cursor"]]
        page = rows[:min(args.get("limit", 25), 25)]
        return {"items": [{"address": address, **{key: node[key] for key in args["fields"]}} for address, node in page],
                **({"next_cursor": page[-1][0]} if len(rows) > len(page) else {})}


MARK = "crew-planning:host:run-1"


def claim_receipt(addresses, assignee=MARK):
    """A confirmed claim: one full AC save with data.assignee per criterion."""
    return {"status": "confirmed", "server": "https://example.invalid/mcp", "arguments": {"workspace": "example",
            "operations": [{"command": {"op": "save_object", "kind": address.split(":")[0], "id": address.split(":")[1],
                "revision": 3, "parent": "rule:r", "data": {"title": address, "owner": "owner", "assignee": assignee},
                "links": [], "reason": "Take this criterion for Crew planning.", "question_checked": "Which rule?"}}
                for address in addresses]},
            "result": {"results": [{"position": 22 + index} for index, _ in enumerate(addresses)]}}


def raw_ac(address, assignee=None, revision=4):
    """A live joppa_objects detail: data, revision, parent and links. No claim process."""
    data = {"title": address, "owner": "owner", "custom": "keep"}
    if assignee:
        data["assignee"] = assignee
    return {"address": address, "data": data, "revision": revision, "parent": "rule:r",
            "links": [{"target": "note:n", "relation": "related", "blocking": False}],
            "status": {"tone": "orange", "label": "No tests"}}


def hold(task, reason="Failed"):
    """Joppa holds a live node with assessment state waiting and a short reason code."""
    task["process"]["assessment"] = {"state": "waiting", "reason": reason}


def end(task, commit=None):
    """An ended Task is archived. A done Task also has data.commit."""
    task["document"]["present"] = False
    if commit:
        task["document"]["data"]["commit"] = commit
