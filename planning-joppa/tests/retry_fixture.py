"""A Joppa fake that applies each batch atomically and fences assess on expected_position. No network."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
from common import write
from mcp import Rejected
import context
import planning_claims as claims
import publication
import retry_marks

SERVER = "https://example.invalid/mcp"
AC = "criterion:a"
START = datetime(2026, 11, 5, 10, 0, tzinfo=timezone.utc)


def at(seconds):
    return START + timedelta(seconds=seconds)


class Joppa:
    """Live ACs as {address: {revision, data, assessment}}. A stale revision or position refuses the whole batch."""
    def __init__(self, revision=3, assessment=None):
        self.url, self.calls, self.journal = SERVER, [], 900
        self.acs = {AC: {"revision": revision, "data": {"title": AC, "owner": "owner"}, "assessment": assessment}}

    def read(self, address):
        ac = self.acs[address]
        return {"address": address, "data": deepcopy(ac["data"]), "revision": ac["revision"], "parent": "rule:r",
                "links": [], "status": {"tone": "orange", "label": "No tests"},
                "process": {"assessment": deepcopy(ac["assessment"])} if ac["assessment"] else {}}

    def assess(self, acs, address, ready, reason, actor):
        self.journal += 1
        acs[address]["assessment"] = {"state": "ready" if ready else "waiting", "reason": reason,
                                      "position": self.journal, "actor": actor}
        return self.journal

    def operator(self, ready=False, reason="OWNER_HOLD"):
        """An operator assessment with the same shared credentials. It takes a new position."""
        return self.assess(self.acs, AC, ready, reason, "operator")

    def edit(self, **data):
        self.acs[AC]["revision"] += 1
        self.acs[AC]["data"].update(data)

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if name == "joppa_objects":
            return self.read(args["address"])
        assert name == "joppa_batch", name
        staged, results = deepcopy(self.acs), []
        for operation in args["operations"]:
            command = operation["command"]
            if command["op"] == "save_object":
                address = command["kind"] + ":" + command["id"]
                if staged[address]["revision"] != command["revision"]:
                    raise Rejected("stale revision")
                staged[address].update(revision=command["revision"] + 1, data=deepcopy(command["data"]))
                self.journal += 1
                results.append({"command": {"op": "save_object"}, "position": self.journal,
                                "object": {"address": address, "revision": staged[address]["revision"]}})
            elif command["op"] == "assess":
                current = (staged[command["target"]]["assessment"] or {}).get("position", 0)
                if "expected_position" in command and command["expected_position"] != current:
                    raise Rejected("stale assessment position")
                position = self.assess(staged, command["target"], command["ready"], command["reason"], "crew")
                results.append({"command": {"op": "assess"}, "object": None, "position": position})
            else:
                self.journal += 1
                results.append({"command": {"op": command["op"]}, "position": self.journal})
        self.acs = staged
        return {"results": results}

    def batches(self):
        return [[item["command"] for item in args["operations"]] for name, args in self.calls if name == "joppa_batch"]


def run_folder(root, number):
    target = Path(root) / f"2026-11-05_10-00-{number:02d}-run{number}" / "artifacts"
    target.mkdir(parents=True)
    return target


def claim(api, root, number, retries=None):
    """The prepare claim path: one batch, then the recorded revisions and positions."""
    target = run_folder(root, number)
    object = context.source(context.object_read(api, "example", AC))
    assignment = {"joppa": {"objects": {AC: object}, "questions": {}}}
    operations = claims.claim_operations(assignment, [{"id": AC, "revision": object["current_revision"]}],
                                         claims.marker(target), retries)
    publication.mutate(api, target / "claim.json", "joppa_batch", {"workspace": "example", "operations": operations},
                       extra={"retry": retries} if retries else None)
    receipt = json.loads((target / "claim.json").read_text())
    receipt["revisions"] = claims.claimed_revisions(receipt)
    receipt["positions"] = retry_marks.claimed_positions(api, "example", receipt, assignment["joppa"]["objects"],
                                                         retries or {})
    write(target / "claim.json", receipt)
    return target


def fail(api, target, code="PLANNING_FAILED"):
    return publication.release(api, target, "example", AC, "planning failed", code)


def release_receipt(target):
    return json.loads((target / "release.json").read_text())
