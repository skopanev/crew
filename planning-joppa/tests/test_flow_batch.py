"""Atomic multi-object claims and native completion against a transactional tracker fixture."""
from copy import deepcopy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "planning-joppa"), str(ROOT / "planning")]
from common import read, write
from mcp import Rejected
from provider_fixture import item, merged
from test_configured_flow import Tracker
import flow_stages
import flow_publication


class AtomicTracker(Tracker):
    def __init__(self):
        super().__init__()
        self.nodes = {"work:t" + str(index): item("work:t" + str(index), "criterion:a", {
            "title": "Task " + str(index), "repository": "other" if index == 4 else "service",
            "commit": str(index) * 40, "stage": "pending"}) for index in range(1, 5)}
        self.move_before_claim = False

    def call(self, tool, args):
        if tool != "joppa_batch":
            return super().call(tool, args)
        if self.move_before_claim:
            self.nodes["work:t2"]["current_revision"] += 1
        nodes, results, refs = deepcopy(self.nodes), [], {}
        for row in args["operations"]:
            cmd = deepcopy(row["command"])
            if isinstance(cmd.get("revision"), dict):
                ref, field = cmd["revision"]["$ref"].split("/", 1)
                cmd["revision"] = refs[ref][field]
            address = cmd.get("target") or cmd["kind"] + ":" + cmd["id"]
            if cmd["op"] == "note":
                results.append({"command": cmd})
                continue
            node = nodes[address]
            if node["current_revision"] != cmd["revision"]:
                raise Rejected("stale batch object revision")
            if cmd["op"] == "archive_object":
                node["document"]["present"] = False
            else:
                node["document"]["data"] = merged(node["document"]["data"], cmd)
            node["current_revision"] += 1
            node["document"]["revision"] = node["current_revision"]
            result = {"command": cmd, "saved_revision": node["current_revision"],
                      **({"object": {"address": address, "revision": node["current_revision"]}}
                         if cmd["op"] == "save_object" else {})}
            results.append(result)
            if row.get("ref"):
                refs[row["ref"]] = result
        self.nodes = nodes
        self.batches.append(deepcopy(args))
        return {"results": results}


class FlowBatchTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.target = self.folder / "run" / "artifacts"
        self.api = AtomicTracker()
        self.config = {"workspace": "example", "url": self.api.url, "runs_folder": str(self.folder),
            "selection": {"kind": "work"}, "batch": {"size": 3, "by": "data.repository"},
            "order": [{"field": "revision", "direction": "asc"}],
            "publication": {"file": "operations.json", "allowed_operations": ["save_object", "archive_object", "note"],
                            "create_kinds": [], "update_kinds": ["work"]}}
        self.enterContext(patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.target.parent), "PLANNING_JOPPA_ITEM": "work:t1"}))
        self.enterContext(patch.object(flow_stages, "settings", return_value=self.config))
        self.enterContext(patch.object(flow_stages, "client", return_value=self.api))
        self.enterContext(patch.object(flow_stages, "emit"))

    def test_one_batch_claims_only_the_configured_group_and_completes_a_verified_subset(self):
        flow_stages.prepare()
        assignment = read(self.target / "input.json")
        self.assertEqual([node["address"] for node in assignment["items"]], ["work:t1", "work:t2", "work:t3"])
        self.assertEqual(assignment["claim_revisions"], {"work:t1": 4, "work:t2": 4, "work:t3": 4})
        self.assertNotIn("assignee", self.api.nodes["work:t4"]["document"]["data"])
        write(self.target / "operations.json", {"operations": [
            {"command": {"op": "archive_object", "target": "work:t1", "revision": 4, "reason": "Pinned head landed."}},
            {"command": {"op": "save_object", "kind": "work", "id": "t2", "revision": 4,
                         "data": {"stage": "failed"}, "reason": "This branch failed checks."}},
            {"command": {"op": "note", "target": "work:t3", "id": "pending", "text": "Target moved."}}]})
        flow_publication.publish(self.api, self.config, self.target)
        self.assertFalse(self.api.nodes["work:t1"]["document"]["present"])
        self.assertEqual(self.api.nodes["work:t1"]["document"]["data"]["commit"], "1" * 40)
        self.assertEqual(self.api.nodes["work:t2"]["document"]["data"]["stage"], "failed")
        self.assertEqual(self.api.nodes["work:t3"]["document"]["data"]["stage"], "pending")
        for node in assignment["items"]:
            self.assertNotIn("assignee", self.api.nodes[node["address"]]["document"]["data"])
        self.assertEqual(read(self.target / "result.json")["item_revisions"], {"work:t1": 6, "work:t2": 5, "work:t3": 5})

    def test_stale_member_refuses_the_whole_claim(self):
        self.api.move_before_claim = True
        with self.assertRaisesRegex(Rejected, "stale batch"):
            flow_stages.prepare()
        self.assertEqual(self.api.batches, [])
        self.assertTrue(all(not node["document"]["data"].get("assignee") for node in self.api.nodes.values()))
        self.assertEqual(read(self.target / "claim.json")["status"], "rejected")

    def test_blocked_business_outcome_releases_all_items_without_archiving(self):
        flow_stages.prepare()
        write(self.target / "operations.json", {"operations": [],
            "outcome": {"status": "blocked", "reason_code": "BASELINE_RED", "reason": "Target checks already fail."}})
        flow_publication.publish(self.api, self.config, self.target)
        result = read(self.target / "result.json")
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(result["claim_released"])
        self.assertFalse(result["acceptance_verified"])
        import publication
        publication.ensure_recovered(self.folder, self.folder / "next" / "artifacts", self.api.url, "example", "work:t1")
        self.assertTrue(all(node["document"]["present"] for node in self.api.nodes.values()))
        self.assertTrue(all(not node["document"]["data"].get("assignee") for node in self.api.nodes.values()))


if __name__ == "__main__":
    unittest.main()
