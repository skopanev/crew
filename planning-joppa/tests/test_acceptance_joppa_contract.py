"""Independent acceptance tests for requirement:hp7fj3b8 (black box from the criteria and their Sources).

ac:kvhlsurf  A revised contract clears the hold
ac:7xkd20fr  Flow relations stay out of planning dependency links
ac:cj3sulbw  A revision read stays historical
"""
from copy import deepcopy
import unittest

from provider_fixture import assignment, plan, hold  # noqa: F401  (sets sys.path for planning modules)
import publication
from task_contracts import contract_fields
from context_reads import object_read
from mcp import complete_object


def held_update(previous):
    """A plan that updates work:old (read revision 3, held with GATE_FAIL) whose stored contract is `previous`."""
    value, work = assignment(), plan()
    task = value["joppa"]["objects"]["work:old"]
    task["document"]["data"].update(previous)
    hold(task, "GATE_FAIL")
    work["tasks"][0].update(action="update", target="work:old", revision=3)
    return work, value


def task_saves(operations):
    return [item["command"] for item in operations
            if item["command"].get("op") == "save_object" and item["command"].get("kind") == "work"
            and item["command"].get("id") == "old"]


class RevisedContractClearsHold(unittest.TestCase):
    """ac:kvhlsurf"""

    def test_changed_body_sends_hold_null_in_the_same_save(self):
        work, value = held_update({})
        previous = contract_fields(work["tasks"][0])
        previous["body"] = "Goal: Old output from 2 rows"
        work, value = held_update(previous)
        saves = task_saves(publication.operations(work, value))
        self.assertEqual(len(saves), 1)
        self.assertEqual(saves[0]["revision"], 3)
        self.assertEqual(saves[0]["data"]["body"], "Goal: Observable output")
        self.assertIn("hold", saves[0]["data"])
        self.assertIsNone(saves[0]["data"]["hold"])
        self.assertNotIn("steps", saves[0]["data"], "only the body changed")

    def test_changed_steps_sends_hold_null_in_the_same_save(self):
        work, _ = held_update({})
        previous = contract_fields(work["tasks"][0])
        previous["steps"] = ["Reject invalid input in 3 places."]
        work, value = held_update(previous)
        saves = task_saves(publication.operations(work, value))
        self.assertEqual(len(saves), 1)
        self.assertEqual(saves[0]["data"]["steps"], ["Use the existing mechanism and reject invalid input."])
        self.assertNotIn("body", saves[0]["data"], "only the steps changed")
        self.assertIn("hold", saves[0]["data"])
        self.assertIsNone(saves[0]["data"]["hold"])

    def test_unchanged_body_and_steps_do_not_clear_the_hold(self):
        work, _ = held_update({})
        work, value = held_update(contract_fields(work["tasks"][0]))
        try:
            operations = publication.operations(work, value)
        except ValueError:
            return  # refused before any write: the hold stays
        for command in task_saves(operations):
            self.assertFalse("hold" in command["data"] and command["data"]["hold"] is None,
                             "an unchanged contract must not send hold: null")


def raw_task(relations):
    """A live joppa_objects detail of work:old at revision 4."""
    return {"address": "work:old", "kind": "work", "revision": 4, "current_revision": 4, "historical": False,
            "parent": "criterion:a", "present": True,
            "data": {"title": "Existing", "owner": "owner", "body": "Goal: export 3 rows"},
            "relations": deepcopy(relations), "status": {"tone": "blue"},
            "comments": {"items": [], "total": 0, "next_cursor": None}}


class Api:
    def __init__(self, value):
        self.value = value

    def call(self, name, args):
        assert name == "joppa_objects"
        return deepcopy(self.value)


def planning_links(relations):
    return object_read(Api(raw_task(relations)), "example", "work:old")["document"]["links"]


BASE = {"depends_on": {"edges": [{"to": "work:dependency"}]},
        "related": {"edges": [{"to": "record:note", "revision": 3}]}}


class FlowRelationsStayOut(unittest.TestCase):
    """ac:7xkd20fr"""

    def test_added_flow_edge_leaves_links_unchanged(self):
        before = planning_links(BASE)
        after = planning_links({**BASE, "next_step": {"edges": [{"to": "work:t2"}]}})
        self.assertEqual(len(before), 2)
        self.assertEqual(after, before)

    def test_removed_flow_edge_leaves_links_unchanged(self):
        before = planning_links({**BASE, "review_flow": {"edges": [{"to": "work:t2"}, {"to": "work:t3"}]}})
        after = planning_links({**BASE, "review_flow": {"edges": [{"to": "work:t2"}]}})
        self.assertEqual(after, before)
        self.assertEqual(after, planning_links(BASE))

    def test_added_depends_on_edge_changes_links(self):
        before = planning_links(BASE)
        after = planning_links({**BASE, "depends_on": {"edges": [{"to": "work:dependency"}, {"to": "work:t5"}]}})
        self.assertNotEqual(after, before)
        self.assertEqual(sum(1 for link in after if link["relation"] == "depends_on"), 2)

    def test_added_related_edge_changes_links(self):
        before = planning_links(BASE)
        after = planning_links({**BASE, "related": {"edges": [{"to": "record:note", "revision": 3}, {"to": "record:n2"}]}})
        self.assertNotEqual(after, before)
        self.assertEqual(sum(1 for link in after if link["relation"] == "related"), 2)


class RevisionReadStaysHistorical(unittest.TestCase):
    """ac:cj3sulbw"""

    def test_revision_1_of_a_node_at_revision_5_reads_historical(self):
        value = {"address": "work:old", "kind": "work", "revision": 1, "current_revision": 5, "historical": True,
                 "parent": "criterion:a", "present": True, "data": {"title": "Old", "owner": "owner", "body": "Goal: v1"},
                 "relations": {}, "comments": {"items": [], "total": 0, "next_cursor": None}}
        args = {"workspace": "example", "address": "work:old", "revision": 1}
        result = complete_object(lambda name, page: deepcopy(value), args, deepcopy(value))
        self.assertIs(result["historical"], True)
        self.assertEqual(result["current_revision"], 5)
        self.assertEqual(result["document"]["revision"], 1)


if __name__ == "__main__":
    unittest.main()
