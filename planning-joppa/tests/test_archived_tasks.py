"""Archived done Tasks stay in planning context. No network or live mutations."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
import context

from provider_fixture import item, assignment, end, hold, CHECK_TYPE

TYPES = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "project": {"role": "document"},
         "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                  "references": {"projects": {"multiple": True, "target": "project"}}}, "check": CHECK_TYPE}
TONES = {"red", "yellow", "orange", "grey", "green", "purple"}


class Workspace:
    """Lists give present objects by default. All six tones also give archived objects."""
    def __init__(self, criteria):
        self.objects = {address: item(address, "rule:r") for address in criteria}
        self.objects.update({"rule:r": item("rule:r"), "project:p": item("project:p")})
        self.criteria, self.lists = list(criteria), []

    def task(self, address, parent):
        self.objects[address] = item(address, parent)
        return self.objects[address]

    def call(self, name, args):
        if name == "joppa_tree":
            return {"schema": {"types": deepcopy(TYPES)}}
        if args.get("kind") == "check" or args.get("related_to"):
            return {"items": []}
        if "address" in args:
            return deepcopy(self.objects[args["address"]])
        if args.get("parent") == "rule:r" and not args.get("kind"):
            return {"items": [{"address": address, "kind": "criterion", "present": True} for address in self.criteria]}
        assert args.get("kind") == "work", args
        assert "status" not in args or set(args["status"]) == TONES, args["status"]
        self.lists.append(deepcopy(args))
        return {"items": [{"address": address} for address, object in sorted(self.objects.items())
                          if object["kind"] == "work" and object["document"]["parent"] == args["parent"]
                          and ("status" in args or object["document"]["present"])]}


CONFIG = {"workspace": "example", "repositories": assignment()["repositories"]}
criteria = lambda value: [entry["id"] for entry in value["joppa"]["criteria"]]
tasks = lambda value: sorted(task["address"] for task in value["joppa"]["tasks"])


class ArchivedTaskTests(unittest.TestCase):
    def test_selected_criterion_keeps_done_and_failed_tasks(self):
        api = Workspace(["criterion:a"])
        end(api.task("work:done", "criterion:a"), "a" * 40)
        hold(api.task("work:failed", "criterion:a"))
        value, snapshot, _ = context.load(api, CONFIG, "criterion:a")
        self.assertEqual(tasks(value), ["work:done", "work:failed"])
        self.assertIs(value["joppa"]["objects"]["work:done"]["document"]["present"], False)
        self.assertIn("work:done", snapshot["objects"])
        self.assertTrue(api.lists and all(set(args["status"]) == TONES for args in api.lists))
        # A live failure still admits the criterion. The landed work stays in its context.
        grouped, _, _ = context.load_requirement(api, CONFIG, "rule:r")
        self.assertEqual(criteria(grouped), ["criterion:a"])
        self.assertEqual(tasks(grouped), ["work:done", "work:failed"])

    def test_completed_sibling_is_not_a_candidate(self):
        api = Workspace(["criterion:a", "criterion:b"])
        for address in ("work:b1", "work:b2"):
            end(api.task(address, "criterion:b"), "b" * 40)
        value, _, _ = context.load_requirement(api, CONFIG, "rule:r")
        self.assertEqual(criteria(value), ["criterion:a"])
        self.assertIn("work:b1", value["joppa"]["objects"])
        self.assertEqual(api.objects["criterion:b"]["status"]["tone"], "orange")
        # A retired Task without a commit is not landed work.
        api.objects["work:b2"]["document"]["data"].pop("commit")
        api.objects["work:b1"]["document"]["data"].pop("commit")
        self.assertEqual(criteria(context.load_requirement(api, CONFIG, "rule:r")[0]), ["criterion:a", "criterion:b"])
        # A live unassigned failure next to landed work admits the criterion again.
        api.objects["work:b1"]["document"]["data"]["commit"] = "b" * 40
        hold(api.task("work:b3", "criterion:b"))
        value, _, _ = context.load_requirement(api, CONFIG, "rule:r")
        self.assertEqual(criteria(value), ["criterion:a", "criterion:b"])
        self.assertEqual(tasks(value), ["work:b1", "work:b2", "work:b3"])
        api.objects["work:b3"]["document"]["data"]["assignee"] = "crew-lane:host:run"
        self.assertEqual(criteria(context.load_requirement(api, CONFIG, "rule:r")[0]), ["criterion:a"])

    def test_done_only_criterion_is_refused(self):
        api = Workspace(["criterion:a"])
        end(api.task("work:done", "criterion:a"), "a" * 40)
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(api, CONFIG, "rule:r")
        with self.assertRaisesRegex(ValueError, "no longer ready"):
            context.load_requirement(api, CONFIG, "rule:r", ["criterion:a"])


if __name__ == "__main__":
    unittest.main()
