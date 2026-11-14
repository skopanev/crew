"""Exercise configured publication against revision-checked native tracker operations."""
from copy import deepcopy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "planning-joppa"), str(ROOT / "planning")]
from common import digest, read, write
from joppa_reads import normalize_detail
from provider_fixture import item, merged
import flow_stages
import flow_publication


class Tracker:
    url = "https://tracker.example/mcp"

    def __init__(self):
        self.nodes = {"criterion:a": item("criterion:a", data={"title": "Accept a valid input", "sources": ["s"]}),
                      "source:s": item("source:s", data={"title": "Approved rule", "body": "Reject unsafe input"}),
                      "work:t": item("work:t", "criterion:a", {"title": "Implement the rule", "stage": "waiting", "custom": 7})}
        self.schema = {"types": {"criterion": {"references": {"sources": {"target": "source"}}}, "work": {}, "check": {}}}
        self.batches = []

    def call(self, tool, args):
        if tool == "joppa_tree":
            return {"schema": deepcopy(self.schema)}
        if tool == "joppa_help":
            return {"operation": "save_object"}
        if tool == "joppa_objects":
            if args.get("address"):
                return deepcopy(self.nodes[args["address"]])
            kinds = args.get("kind")
            kinds = [kinds] if isinstance(kinds, str) else kinds
            return {"items": [{"address": node["address"], "revision": node["current_revision"],
                               "parent": node["document"]["parent"]} for node in self.nodes.values()
                    if (not kinds or node["kind"] in kinds) and
                    ("parent" not in args or node["document"]["parent"] == args["parent"])]}
        assert tool == "joppa_batch", tool
        commands = [row["command"] for row in args["operations"]]
        for command in commands:
            if command["op"] == "save_object" and command["revision"]:
                address = command["kind"] + ":" + command["id"]
                assert self.nodes[address]["current_revision"] == command["revision"]
        self.batches.append(deepcopy(args))
        results = []
        for command in commands:
            if command["op"] == "note":
                results.append({})
                continue
            address = command["kind"] + ":" + command.get("id", "generated")
            old = self.nodes.get(address)
            data = merged(old["document"]["data"] if old else {}, command)
            rev = command["revision"] + 1
            node = item(address, command.get("parent", old["document"]["parent"] if old else None), data)
            node["current_revision"] = node["document"]["revision"] = rev
            self.nodes[address] = node
            results.append({"object": {"revision": rev}})
        return {"results": results}


class ConfiguredFlowTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.target = self.folder / "run" / "artifacts"
        self.api = Tracker()
        self.config = {"workspace": "example", "url": self.api.url, "runs_folder": str(self.folder),
            "selection": {"kind": "criterion"}, "exclude_children": {"kind": "check"},
            "references": ["sources"], "children": {"kind": "work"},
            "publication": {"file": "operations.json", "allowed_operations": ["save_object", "note"],
                            "create_kinds": ["check"], "update_kinds": ["work"]}}
        self.enterContext(patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.target.parent),
                                                  "PLANNING_JOPPA_ITEM": "criterion:a"}))
        self.enterContext(patch.object(flow_stages, "settings", return_value=self.config))
        self.enterContext(patch.object(flow_stages, "client", return_value=self.api))
        flow_stages.prepare()

    def output(self):
        return {"operations": [{"command": {"op": "save_object", "kind": "check", "revision": 0,
            "parent": "criterion:a", "data": {"title": "Unsafe input causes no change"}, "reason": "Publish reviewed test text."}},
            {"command": {"op": "save_object", "kind": "work", "id": "t", "revision": 3,
             "data": {"stage": "ready"}, "reason": "Independent test text is ready."}}]}

    def test_publication_creates_children_updates_stage_and_releases_one_claim(self):
        write(self.target / "operations.json", self.output())
        flow_publication.publish(self.api, self.config, self.target)
        self.assertEqual(len(self.api.batches), 2)
        self.assertEqual(self.api.nodes["work:t"]["document"]["data"],
                         {"title": "Implement the rule", "stage": "ready", "custom": 7})
        self.assertNotIn("assignee", self.api.nodes["criterion:a"]["document"]["data"])
        result = read(self.target / "result.json")
        self.assertEqual((result["status"], result["selected_revision"]), ("published", 5))
        self.assertFalse(result["acceptance_verified"])

    def test_changed_source_stops_publication_and_failure_leaves_note_without_stage_change(self):
        self.api.nodes["source:s"]["current_revision"] += 1
        write(self.target / "operations.json", self.output())
        with self.assertRaisesRegex(ValueError, "flow input changed: source:s"):
            flow_publication.publish(self.api, self.config, self.target)
        flow_publication.fail(self.api, self.config, self.target, "Source changed during the flow")
        self.assertEqual(self.api.nodes["work:t"]["document"]["data"]["stage"], "waiting")
        self.assertEqual(self.api.batches[-1]["operations"][-1]["command"]["op"], "note")
        self.assertEqual(read(self.target / "result.json")["selected_revision"], 5)

    def test_out_of_scope_write_is_refused_before_network_mutation(self):
        output = self.output()
        output["operations"][1]["command"].update(kind="source", id="s")
        write(self.target / "operations.json", output)
        with self.assertRaisesRegex(ValueError, "outside the configured"):
            flow_publication.publish(self.api, self.config, self.target)
        self.assertEqual(len(self.api.batches), 1)

    def test_uncertain_claim_stays_held_without_another_mutation(self):
        receipt = read(self.target / "claim.json")
        write(self.target / "claim.json", {**receipt, "status": "uncertain"})
        flow_publication.fail(self.api, self.config, self.target, "The claim response was lost")
        result = read(self.target / "result.json")
        self.assertTrue(result["needs_recovery"])
        self.assertFalse(result["claim_released"])
        self.assertEqual(len(self.api.batches), 1)


if __name__ == "__main__":
    unittest.main()
