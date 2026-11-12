"""Independent acceptance tests (black box from the criteria and their Sources).

ac:dnmh2gaz  Requirement context needs no project node
ac:cseqtlfz  Single-criterion context needs no project node
ac:1k8wc6ej  A malformed configured Task stays in unfinished work

Sources: source:qvg9xxp2 (repository scope without projects), source:sd0s9yge (repository declarations).
"""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from provider_fixture import item, assignment, CHECK_TYPE  # noqa: F401  (sets sys.path for planning modules)
from test_generic_lifecycle import raw
import context

# The Task type has no projects reference. The workspace has no project node.
TYPES = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"},
         "work": {"role": "task", "parents": ["criterion"], "question": "What work?"}, "check": CHECK_TYPE}


class Workspace:
    """Serve one Requirement rule:r with criteria criterion:a and criterion:b. Record every call."""

    def __init__(self, tasks=()):
        self.objects = {"rule:r": item("rule:r"), "criterion:a": item("criterion:a", "rule:r"),
                        "criterion:b": item("criterion:b", "rule:r")}
        for task in tasks:
            self.objects[task["address"]] = task
        self.calls = []

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if name == "joppa_tree":
            return {"position": 20, "schema": {"types": deepcopy(TYPES)}}
        if "address" in args:
            return deepcopy(self.objects[args["address"]])
        if args.get("kind") == "work":
            return {"items": [{"address": address} for address, value in self.objects.items()
                              if value["kind"] == "work" and value["document"]["parent"] == args["parent"]]}
        if args.get("parent") == "rule:r" and not args.get("kind"):
            return {"items": [{"address": address, "kind": "criterion", "present": True}
                              for address in ("criterion:a", "criterion:b")]}
        return {"items": []}

    def project_reads(self):
        return [args for name, args in self.calls
                if "project" in json.dumps(args) or str(args.get("address", "")).startswith("project:")]


def planner_config(case):
    """A planner configuration file whose repository service names no project field."""
    folder = Path(tempfile.mkdtemp(prefix="crew-accept-scope-"))
    case.addCleanup(__import__("shutil").rmtree, folder, True)
    raw_config = {"workspace": "example", "url": "https://example.invalid/mcp", "token_file": "token",
                  "runs_folder": "runs", "cbm_store": "cbm", "cbm_root": "cbm-root", "equill_store": "equill",
                  "repositories": [{"id": "service", "path": "service", "cbm_project": "service",
                                    "modules": [{"name": "core", "path": "src"}]}]}
    path = folder / "config.json"
    path.write_text(json.dumps(raw_config))
    return context.configuration(str(path))


def open_task(address, parent):
    """An open Task with a Repository declaration and no projects field."""
    return item(address, parent, {"title": "[01] Export 2 rows", "owner": "owner",
                                  "body": "Goal: export 2 rows\nRepository: service\nModule: core"})


class RequirementContextNeedsNoProjectNode(unittest.TestCase):
    """ac:dnmh2gaz"""

    def test_requirement_rule_r_is_captured_without_any_project_read(self):
        config = planner_config(self)
        self.assertNotIn("project", config["repositories"][0])
        server = Workspace()
        data, snapshot, requirement = context.load_requirement(server, config, "rule:r")
        self.assertEqual(requirement["address"], "rule:r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a", "criterion:b"])
        self.assertEqual(snapshot["criteria"], ["criterion:a", "criterion:b"])
        self.assertEqual(server.project_reads(), [], "the capture reads no project node")
        self.assertFalse([key for key in snapshot["objects"] if key.startswith("project:")])

    def test_requirement_with_an_open_task_without_projects_is_captured(self):
        config = planner_config(self)
        server = Workspace([open_task("work:t1", "criterion:a")])
        data, snapshot, requirement = context.load_requirement(server, config, "r")
        self.assertEqual(requirement["address"], "rule:r")
        self.assertIn("work:t1", snapshot["objects"])
        self.assertNotIn("projects", data["joppa"]["objects"]["work:t1"]["document"]["data"])
        self.assertEqual(server.project_reads(), [])


class SingleCriterionContextNeedsNoProjectNode(unittest.TestCase):
    """ac:cseqtlfz"""

    def test_ac_id_criterion_a_is_captured_without_any_project_read(self):
        config = planner_config(self)
        server = Workspace()
        data, snapshot, ac = context.load(server, config, "criterion:a")
        self.assertEqual(ac["address"], "criterion:a")
        self.assertEqual(data["ac"]["id"], "criterion:a")
        self.assertEqual(data["requirement"]["id"], "rule:r")
        self.assertEqual(data["repositories"][0]["id"], "service")
        self.assertNotIn("project", data["repositories"][0])
        self.assertEqual(server.project_reads(), [], "the capture reads no project node")
        self.assertFalse([key for key in snapshot["objects"] if key.startswith("project:")])

    def test_short_ac_id_a_with_an_open_task_without_projects_is_captured(self):
        config = planner_config(self)
        server = Workspace([open_task("work:t1", "criterion:a")])
        data, _, ac = context.load(server, config, "a")
        self.assertEqual(ac["address"], "criterion:a")
        self.assertEqual([task["address"] for task in data["joppa"]["tasks"]], ["work:t1"])
        self.assertEqual(server.project_reads(), [])


# Structured Task without data.module: its contract fails validation, but data.repository declares service.
MALFORMED = {"title": "[01] Broken export", "owner": "owner", "body": "Goal: export 2 rows",
             "repository": "service", "steps": ["Add the export."], "checks": ["Export => 2 rows"]}
VALID = {"title": "[02] Valid export", "owner": "owner",
         "body": "Goal: export 3 rows\nRepository: service\nModule: core\n\nHow:\n1. Add the export.\n\nChecks:\nExport => 3 rows"}


class UnfinishedWork:
    """Serve a Task list page in the given order and the live detail of each Task."""

    def __init__(self, tasks):
        self.tasks, self.calls = tasks, []

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if "address" in args:
            address = args["address"]
            return raw(address, deepcopy(self.tasks[address]), revision=5, parent="criterion:z",
                       kind="work", current_revision=5, present=True, historical=False)
        fields = ("title", "parent", "revision", "body", "repository", "steps")
        return {"items": [{"address": address, **{key: data.get(key) for key in fields}}
                          for address, data in self.tasks.items()]}


def unfinished(tasks):
    return context.pending_work(UnfinishedWork(tasks), {"workspace": "example",
                                "repositories": [{"id": "service"}]}, assignment())


class MalformedConfiguredTaskStaysInUnfinishedWork(unittest.TestCase):
    """ac:1k8wc6ej"""

    def test_malformed_work_m1_listed_before_valid_work_v2_both_stay_in_the_list(self):
        result = unfinished({"work:m1": MALFORMED, "work:v2": VALID})
        self.assertEqual([entry["address"] for entry in result], ["work:m1", "work:v2"])
        self.assertEqual(result[0]["repository"], "service")
        self.assertEqual(result[1]["repository"], "service")

    def test_only_malformed_work_m1_in_the_queue_is_listed_with_its_address(self):
        result = unfinished({"work:m1": MALFORMED})
        self.assertEqual([entry["address"] for entry in result], ["work:m1"])

    def test_malformed_task_of_unconfigured_repository_other_is_not_listed(self):
        result = unfinished({"work:m1": {**MALFORMED, "repository": "other"}, "work:v2": VALID})
        self.assertEqual([entry["address"] for entry in result], ["work:v2"])


if __name__ == "__main__":
    unittest.main()
