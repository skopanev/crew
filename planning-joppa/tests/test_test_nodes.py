"""Test node reads, freshness and candidate status. No network or live mutations."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
import context
from test_nodes import NODE_FIELDS, read_nodes

from provider_fixture import item, assignment, NodeServer, CHECK_TYPE

TYPES = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "project": {"role": "document"},
         "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                  "references": {"projects": {"multiple": True, "target": "project"}}}, "check": CHECK_TYPE}


class Workspace(NodeServer):
    """Serve criteria, a Requirement and their test nodes."""
    def __init__(self):
        super().__init__()
        self.objects = {address: item(address, "rule:r") for address in ("criterion:a", "criterion:b")}
        for object in self.objects.values():
            object["process"]["assessment"] = {"state": "ready"}
        self.objects.update({"rule:r": item("rule:r"), "project:p": item("project:p")})

    def call(self, name, args):
        if name == "joppa_tree":
            return {"schema": {"types": deepcopy(TYPES), "test_results": {"max_tests": 200}}}
        if args.get("kind") == "check" or args.get("address") in self.nodes:
            return super().call(name, args)
        if "address" in args:
            return deepcopy(self.objects[args["address"]])
        if args.get("parent") == "rule:r" and not args.get("kind"):
            return {"items": [{"address": address, "kind": "criterion", "present": True}
                              for address in ("criterion:a", "criterion:b")]}
        return {"items": []}


class TestNodeTests(unittest.TestCase):
    def test_paginated_read_groups_every_node_by_criterion(self):
        api = NodeServer()
        for number in range(30):
            api.add(f"check:a{number:02}", "criterion:a", f"a.rs > case {29 - number:02}", revision=number + 1)
        for number in range(3):
            api.add(f"check:b{number}", "criterion:b", f"b.rs > case {number}", status="red")
        api.add("check:other", "criterion:other", "c.rs > case", ancestor="rule:other")
        grouped = read_nodes(api, "example", "check", "rule:r", ["criterion:a", "criterion:b", "criterion:c"])
        self.assertEqual(len(grouped["criterion:a"]), 30)
        self.assertEqual(grouped["criterion:a"][0], {"address": "check:a29", "title": "a.rs > case 00",
                                                     "revision": 30, "status": "green"})
        self.assertEqual([node["status"] for node in grouped["criterion:b"]], ["red"] * 3)
        self.assertEqual(grouped["criterion:c"], [])
        pages = [args for _, args in api.calls]
        self.assertEqual(len(pages), 2)
        self.assertTrue(all(args["fields"] == NODE_FIELDS and args["kind"] == "check" for args in pages))
        self.assertEqual((pages[0].get("cursor"), pages[1]["cursor"]), (None, "check:a24"))
        class Stuck(NodeServer):
            def call(self, name, args):
                return {**super().call(name, args), "next_cursor": "check:a00"}
        stuck = Stuck(api.nodes)
        with self.assertRaisesRegex(ValueError, "did not advance"):
            read_nodes(stuck, "example", "check", "criterion:a", ["criterion:a"])
        broken = NodeServer({"check:x": {**api.nodes["check:a00"], "title": ""}})
        with self.assertRaisesRegex(ValueError, "incomplete"):
            read_nodes(broken, "example", "check", "criterion:a", ["criterion:a"])

    def test_snapshot_changes_when_a_node_changes_under_an_unchanged_criterion(self):
        api = Workspace()
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, snapshot, _ = context.load(api, config, "criterion:a")
        self.assertEqual(value["joppa"]["test_nodes"], [])
        self.assertEqual(value["joppa"]["test_type"], "check")
        self.assertEqual(snapshot["tests"], {"criterion:a": []})
        api.add("check:new", "criterion:a", "a.rs > bound")
        _, added, _ = context.load(api, config, "criterion:a")
        self.assertEqual(added["objects"]["criterion:a"], snapshot["objects"]["criterion:a"])
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(snapshot, added)
        api.nodes["check:new"]["status"] = "red"
        _, result_only, _ = context.load(api, config, "criterion:a")
        context.unchanged(added, result_only)
        for key, change in (("revision", 2), ("title", "a.rs > renamed")):
            with self.subTest(key=key):
                api.nodes["check:new"][key] = change
                _, changed, _ = context.load(api, config, "criterion:a")
                with self.assertRaisesRegex(ValueError, "context changed"):
                    context.unchanged(added, changed)
        _, grouped, _ = context.load_requirement(api, config, "rule:r")
        api.add("check:b", "criterion:b", "b.rs > bound")
        _, grouped_added, _ = context.load_requirement(api, config, "rule:r")
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(grouped, grouped_added)

    def test_orange_criterion_without_tests_remains_a_candidate(self):
        api = Workspace()
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, _, _ = context.load_requirement(api, config, "rule:r")
        self.assertEqual([entry["id"] for entry in value["joppa"]["criteria"]], ["criterion:a", "criterion:b"])
        self.assertEqual(value["joppa"]["criterion_schemas"]["criterion:b"]["test_nodes"], [])
        api.objects["criterion:a"]["status"] = {"tone": "green", "label": "Children checks passed"}
        api.add("check:a", "criterion:a", "a.rs > bound")
        value, _, _ = context.load_requirement(api, config, "rule:r")
        self.assertEqual([entry["id"] for entry in value["joppa"]["criteria"]], ["criterion:b"])
        api.objects["criterion:b"]["status"] = {"tone": "red", "label": "Checks failed"}
        value, _, _ = context.load_requirement(api, config, "rule:r")
        self.assertEqual([entry["id"] for entry in value["joppa"]["criteria"]], ["criterion:b"])
        api.objects["criterion:b"].pop("status")
        with self.assertRaisesRegex(ValueError, "criterion status is missing"):
            context.load_requirement(api, config, "rule:r")


if __name__ == "__main__":
    unittest.main()
