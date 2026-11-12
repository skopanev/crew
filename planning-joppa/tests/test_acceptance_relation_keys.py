"""Independent acceptance tests for ac:sd5k9rva (black box from the criterion and its Sources).

ac:sd5k9rva  Saves omit unchanged relation keys: when Crew saves a node, the save omits each relation key
whose edges the save does not change. Joppa keeps an omitted relation key; a sent key replaces its edges.

A plan removes a depends_on edge only by retiring the target Task in the same plan (planning-joppa README:
"Keep required dependencies explicit"), so the change and removal scenarios retire the old target.
"""
from copy import deepcopy
import unittest

from provider_fixture import assignment, plan, hold  # noqa: F401  (sets sys.path for planning modules)
import publication


def existing_task(dependencies):
    """Joppa holds work:old (revision 3) with depends_on edges to `dependencies`; the plan updates its body.
    work:t2 and work:t3 are other live Tasks under the same criterion at revision 3."""
    value, work = assignment(), plan()
    for address in ("work:t2", "work:t3"):
        other = deepcopy(value["joppa"]["tasks"][0])
        other["address"], other["id"] = address, address.split(":")[1]
        other["document"]["links"] = []
        value["joppa"]["tasks"].append(other)
        value["joppa"]["objects"][address] = other
    task = value["joppa"]["objects"]["work:old"]
    task["document"]["data"]["body"] = "Goal: export 2 rows"
    task["document"]["links"] += [{"target": address, "relation": "depends_on", "blocking": True}
                                  for address in dependencies]
    work["tasks"][0].update(action="update", target="work:old", revision=3)
    return work, value


def retire(work, value, address):
    """The plan retires the held Task at `address` (Crew planning retires only held Tasks)."""
    hold(value["joppa"]["objects"][address], "Failed")
    task = deepcopy(work["tasks"][0])
    task.update(id="retire-" + address.split(":")[1], action="retire", target=address, revision=3,
                outcome="The approved outcome needs no further work.", depends_on=[])
    work["tasks"].append(task)


def task_save(work, value):
    saves = [entry["command"] for entry in publication.operations(work, value)
             if entry["command"].get("op") == "save_object" and entry["command"].get("id") == "old"]
    assert len(saves) == 1, saves
    return saves[0]


def targets(relation):
    return [edge["to"] for edge in relation["edges"]]


class SavesOmitUnchangedRelationKeys(unittest.TestCase):
    """ac:sd5k9rva"""

    def test_body_change_with_the_same_dependency_sends_no_relation_key(self):
        work, value = existing_task(["work:t2"])
        work["tasks"][0]["depends_on"] = ["work:t2"]
        save = task_save(work, value)
        self.assertIn("body", save["data"], "the body changed")
        self.assertFalse(save.get("relations"), "the dependency on work:t2 did not change")

    def test_dependency_changed_from_t2_to_t3_sends_depends_on_with_t3(self):
        work, value = existing_task(["work:t2"])
        work["tasks"][0]["depends_on"] = ["work:t3"]
        retire(work, value, "work:t2")
        save = task_save(work, value)
        self.assertEqual(targets(save["relations"]["depends_on"]), ["work:t3"])
        self.assertNotIn("related", save["relations"], "the related edge did not change")

    def test_body_change_without_dependencies_sends_no_relation_key(self):
        work, value = existing_task([])
        work["tasks"][0]["depends_on"] = []
        save = task_save(work, value)
        self.assertIn("body", save["data"], "the body changed")
        self.assertFalse(save.get("relations"), "the Task has no dependencies before and after the save")

    def test_one_of_two_dependencies_removed_sends_depends_on_with_the_remaining_edge(self):
        work, value = existing_task(["work:t2", "work:t3"])
        work["tasks"][0]["depends_on"] = ["work:t2"]
        retire(work, value, "work:t3")
        save = task_save(work, value)
        self.assertEqual(targets(save["relations"]["depends_on"]), ["work:t2"])
        self.assertNotIn("related", save["relations"], "the related edge did not change")


if __name__ == "__main__":
    unittest.main()
