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
            result = super().call(tool, args)
            if tool == "joppa_objects" and not args.get("address"):
                from flow_batch import field
                result["items"] = [{"address": row["address"], **{key: field(row, key)
                    for key in args["fields"]}} for row in result["items"]]
            return result
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
            {"command": {"op": "save_object", "kind": "work", "id": "t1", "revision": 4,
                         "data": {"stage": "done"}, "reason": "Pinned head landed."}},
            {"command": {"op": "archive_object", "target": "work:t1", "revision": 4, "reason": "Pinned head landed."}},
            {"command": {"op": "save_object", "kind": "work", "id": "t2", "revision": 4,
                         "data": {"stage": "failed"}, "reason": "This branch failed checks."}},
            {"command": {"op": "note", "target": "work:t3", "id": "pending", "text": "Target moved."}}]})
        flow_publication.publish(self.api, self.config, self.target)
        self.assertFalse(self.api.nodes["work:t1"]["document"]["present"])
        self.assertEqual(self.api.nodes["work:t1"]["document"]["data"]["commit"], "1" * 40)
        self.assertEqual(self.api.nodes["work:t1"]["document"]["data"]["stage"], "done")
        self.assertEqual(self.api.nodes["work:t2"]["document"]["data"]["stage"], "failed")
        self.assertEqual(self.api.nodes["work:t3"]["document"]["data"]["stage"], "pending")
        for node in assignment["items"]:
            self.assertNotIn("assignee", self.api.nodes[node["address"]]["document"]["data"])
        self.assertEqual(read(self.target / "result.json")["item_revisions"], {"work:t1": 6, "work:t2": 5, "work:t3": 5})

    def test_archive_after_save_keeps_the_claim_guard_and_refuses_repeated_changes(self):
        flow_stages.prepare()
        assignment, claim = read(self.target / "input.json"), read(self.target / "claim.json")
        save = {"command": {"op": "save_object", "kind": "work", "id": "t1", "revision": 4,
                            "data": {"stage": "done"}, "reason": "Landed."}}
        archive = {"command": {"op": "archive_object", "target": "work:t1", "revision": 4, "reason": "Landed."}}
        for rows in ([save, save], [save, archive, archive], [archive, save]):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "one guarded save"):
                flow_publication.operations(self.config, assignment, claim, {"operations": rows})
        stale = deepcopy(archive)
        stale["command"]["revision"] = 3
        with self.assertRaisesRegex(ValueError, "stale revision"):
            flow_publication.operations(self.config, assignment, claim, {"operations": [save, stale]})
        self.assertEqual(len(self.api.batches), 1)

    def test_stale_member_refuses_the_whole_claim(self):
        self.api.move_before_claim = True
        with self.assertRaisesRegex(Rejected, "stale batch"):
            flow_stages.prepare()
        self.assertEqual(self.api.batches, [])
        self.assertTrue(all(not node["document"]["data"].get("assignee") for node in self.api.nodes.values()))
        self.assertEqual(read(self.target / "claim.json")["status"], "rejected")

    def test_branch_units_wait_and_claim_all_tasks_of_an_aged_branch(self):
        from datetime import datetime, timezone, timedelta
        self.config["batch"].update(min_size=3, unit_field="data.delivery.branch",
                                    max_wait_seconds=900, age_field="data.delivery.pushed_at")
        for address, node in self.api.nodes.items():
            node["document"]["data"]["delivery"] = {"branch": "one", "pushed_at": datetime.now(timezone.utc).isoformat()}
        with self.assertRaisesRegex(ValueError, "batch waits"):
            flow_stages.prepare()
        self.assertEqual(self.api.batches, [])
        self.api.nodes["work:t1"]["document"]["data"]["delivery"]["pushed_at"] = \
            (datetime.now(timezone.utc) - timedelta(seconds=901)).isoformat()
        flow_stages.prepare()
        self.assertEqual(len(read(self.target / "input.json")["items"]), 3)

    def test_whole_branch_units_fit_the_native_claim_limit(self):
        self.config["batch"].update(min_size=2, unit_field="data.delivery.branch")
        self.api.nodes = {"work:t%03d" % i: item("work:t%03d" % i, "criterion:a", {
            "title": "Task", "repository": "service", "delivery": {"branch": "one" if i < 40 else "two" if i < 60 else "three"}})
            for i in range(70)}
        os.environ["PLANNING_JOPPA_ITEM"] = "work:t000"
        with patch.object(self.api, "call", wraps=self.api.call) as calls:
            flow_stages.prepare()
        reads = [call.args[1].get("address") for call in calls.call_args_list if call.args[0] == "joppa_objects"]
        self.assertFalse(any("work:t%03d" % i in reads for i in range(40, 60)))
        rows = read(self.target / "input.json")["items"]
        self.assertEqual(len(rows), 50)
        self.assertEqual({row["document"]["data"]["delivery"]["branch"] for row in rows}, {"one", "three"})

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
