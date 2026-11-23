"""Keep structural creates before the claim release only when no row they use runs after it."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "planning-joppa"), str(ROOT / "planning")]
import flow_publication


def create(ref, kind, parent):
    return {"ref": ref, "command": {"op": "save_object", "kind": kind, "revision": 0, "parent": parent, "data": {}}}


class StructuralOrderTests(unittest.TestCase):
    def setUp(self):
        self.config = {"selection": {"kind": "ac"}, "publication": {"file": "operations.json",
            "allowed_operations": ["save_object", "note"], "create_kinds": ["ac", "test"], "update_kinds": ["ac"],
            "structure": {"create": {"ac": ["context_parent"], "test": ["created"]}}}}
        selected = {"address": "ac:a", "kind": "ac", "current_revision": 4, "document": {"parent": "requirement:r", "data": {}}}
        self.assignment = {"selected": selected, "children": [], "schema": {"types": {"ac": {}, "test": {}}}}
        self.enterContext(patch.object(flow_publication.claims, "claimed_revisions", return_value={"ac:a": 4}))
        self.save = {"command": {"op": "save_object", "kind": "ac", "id": "a", "revision": 4, "data": {"stage": "s"}}}

    def order(self, rows, permissions):
        with patch.object(flow_publication, "run", return_value=json.dumps(permissions)):
            batch = flow_publication.operations(self.config, self.assignment, {}, {"operations": rows})
        return [row.get("ref") or row["command"]["op"] for row in batch]

    def test_early_structural_creates_precede_the_release(self):
        rows = [create("part", "ac", "requirement:r"), create("part_test", "test", {"$ref": "part/address"}), self.save]
        self.assertEqual(self.order(rows, {"creates": [0, 1], "moves": [], "notes": [], "early": [0, 1]}),
                         ["part", "part_test", "flow_release"])

    def test_a_structural_child_of_a_late_create_follows_its_parent(self):
        rows = [create("own", "test", "ac:a"), create("child", "test", {"$ref": "own/address"}), self.save]
        self.assertEqual(self.order(rows, {"creates": [1], "moves": [], "notes": [], "early": []}),
                         ["flow_release", "own", "child"])


if __name__ == "__main__":
    unittest.main()
