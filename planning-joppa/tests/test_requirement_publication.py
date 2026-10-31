"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
from common import read
import context
from mcp import MCPError, Rejected, Reader
import publication


from provider_fixture import item, assignment, plan, Fake


class ProviderTests(unittest.TestCase):
    def test_retained_sibling_order_and_dependencies_remain_approved(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}],
            criterion_schemas={"criterion:a": {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")}})
        data["decisions"] = [json.dumps({"acs": [{"id": "criterion:a"}, {"id": "criterion:b"}]})]
        retained = context.source(item("work:retained", "criterion:b", {"title": "[07] Approved work", "owner": "owner",
            "purpose": "implementation", "contract": "Repository: service\nModule: core"}, {"status": "open"}))
        data["joppa"]["objects"][retained["address"]] = retained
        value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}]
        value["acceptance_checks"][0]["ac"] = "criterion:a"
        value["tasks"][0]["depends_on"] = ["work:retained"]
        original = deepcopy(retained)
        command = publication.operations(value, data)[0]["command"]
        self.assertTrue(command["data"]["title"].startswith("[08] "))
        self.assertEqual(command["links"][0]["target"], "work:retained")
        self.assertEqual(retained, original)
        retained["document"]["data"]["title"] = "Legacy approved work"
        self.assertTrue(publication.operations(value, data)[0]["command"]["data"]["title"].startswith("[01] "))
        old = data["joppa"]["objects"]["work:old"]
        old["process"]["blocked"] = {"reason": "Failed"}
        old["document"]["data"].update(title="[03] Existing work", contract="Repository: service\nModule: core")
        retained["document"]["data"]["title"] = "[07] Approved work"
        data["joppa"]["tasks"] = [old]
        value["tasks"][0].update(action="update", target="work:old", revision=3, depends_on=[])
        retained["document"]["links"] = [{"target": "work:old", "revision": 3, "relation": "depends_on", "blocking": True}]
        commands = publication.operations(value, data)
        self.assertTrue(commands[0]["command"]["data"]["title"].startswith("[03] "))
        self.assertEqual(retained["document"]["links"][0]["target"], "work:old")
        new = deepcopy(plan()["tasks"][0])
        new.update(id="new", depends_on=["first"])
        value["tasks"].append(new)
        commands = publication.operations(value, data)
        self.assertTrue(commands[1]["command"]["data"]["title"].startswith("[08] "))

    def test_cross_criterion_retirement_cannot_become_a_dependency(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
            criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
        data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed"}
        consumer = deepcopy(data["joppa"]["tasks"][0])
        consumer.update(address="work:consumer")
        consumer["document"]["parent"] = "criterion:b"
        data["joppa"]["tasks"].append(consumer)
        data["joppa"]["objects"][consumer["address"]] = consumer
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "client", "project": "project:q"})
        value["criteria"] = [{"ac": address, "disposition": "implement"} for address in ("criterion:a", "criterion:b")]
        value["acceptance_checks"] = [{**deepcopy(value["acceptance_checks"][0]), "ac": address}
                                      for address in ("criterion:a", "criterion:b")]
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        update = deepcopy(value["tasks"][0])
        update.update(id="consumer", action="update", ac="criterion:b", target="work:consumer", repository="client")
        value["tasks"].append(update)
        for dependency in ("first", "work:old"):
            update["depends_on"] = [dependency]
            with self.assertRaisesRegex(ValueError, "retired by this plan"):
                publication.operations(value, data)

    def test_requirement_tasks_keep_order_and_internal_dependency_links(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[], criterion_schemas={})
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "client", "project": "project:q"})
        value["criteria"], value["tasks"], value["acceptance_checks"] = [], [], []
        for index, address in enumerate(("criterion:a", "criterion:b", "criterion:c")):
            data["joppa"]["criteria"].append({"id": address, "revision": 3})
            data["joppa"]["objects"][address] = context.source(item(address, "rule:r"))
            data["joppa"]["criterion_schemas"][address] = {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")}
            task = deepcopy(plan()["tasks"][0])
            task.update(id=f"step{index}", ac=address, repository="client" if index == 2 else "service",
                        depends_on=[f"step{index - 1}"] if index else ["work:dependency"])
            value["tasks"].append(task)
            value["criteria"].append({"ac": address, "disposition": "implement"})
            value["acceptance_checks"].append({**deepcopy(plan()["acceptance_checks"][0]),
                "ac": address, "repository": task["repository"]})
        # Input order must not change the prerequisite order.
        value["tasks"].reverse()
        commands = publication.operations(value, data)
        saves = [operation["command"] for operation in commands if operation["command"]["op"] == "save_object"]
        self.assertEqual([command["parent"] for command in saves], ["criterion:a", "criterion:b", "criterion:c"])
        self.assertEqual([command["data"]["title"][:4] for command in saves], ["[01]", "[02]", "[01]"])
        self.assertEqual(saves[0]["links"][0]["target"], "work:dependency")
        self.assertIn({"target": {"$ref": "task1/address"}, "revision": {"$ref": "task1/saved_revision"},
                       "relation": "depends_on", "blocking": True}, saves[1]["links"])
        self.assertEqual(saves[2]["links"][0]["target"], {"$ref": "task2/address"})
        self.assertEqual([operation["command"]["ac"] for operation in commands[-3:]],
                         ["criterion:a", "criterion:b", "criterion:c"])
        value["tasks"][0]["ac"] = "criterion:outside"
        with self.assertRaisesRegex(ValueError, "selected Requirement criterion"):
            publication.operations(value, data)

    def test_requirement_explicitly_orders_every_unfinished_selected_task(self):
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", criteria=[{"id": "criterion:a"}],
            criterion_schemas={"criterion:a": {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")}})
        value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"}]
        value["acceptance_checks"][0]["ac"] = "criterion:a"
        old = data["joppa"]["tasks"][0]
        old["process"]["blocked"] = {"reason": "Failed"}
        with self.assertRaisesRegex(ValueError, "explicitly update or retire unfinished Task work:old"):
            publication.operations(value, data)
        provider = deepcopy(old)
        provider["address"] = "work:provider"
        provider["document"]["data"]["contract"] = "Repository: service\nModule: core"
        data["joppa"]["tasks"].append(provider)
        data["joppa"]["objects"][provider["address"]] = provider
        old["document"]["links"].append({"target": "work:provider", "revision": 3,
                                           "relation": "depends_on", "blocking": True})
        consumer = deepcopy(value["tasks"][0])
        consumer.update(action="update", target="work:old", revision=3, depends_on=["work:provider", "work:dependency"])
        value["tasks"] = [consumer]
        with self.assertRaisesRegex(ValueError, "explicitly update or retire unfinished Task work:provider"):
            publication.operations(value, data)
        prerequisite = deepcopy(consumer)
        prerequisite.update(id="provider", target="work:provider", depends_on=[])
        value["tasks"].append(prerequisite)
        done = deepcopy(old)
        done["address"] = "work:done"
        done["process"]["done"] = {"evidence": "Already landed"}
        data["joppa"]["tasks"].append(done)
        operations = publication.operations(value, data)
        saves = [entry["command"] for entry in operations if entry["command"]["op"] == "save_object"]
        self.assertEqual([entry["id"] for entry in saves], ["provider", "old"])
        self.assertEqual([entry["data"]["title"][:4] for entry in saves], ["[01]", "[02]"])
        self.assertFalse(any(link["relation"] == "depends_on" and link["target"] == "work:provider"
                             for entry in saves for link in entry["links"]))
        self.assertTrue(any(link["target"] == "work:dependency" for link in saves[-1]["links"]))
        provider["process"]["assignee"] = "worker"
        with self.assertRaisesRegex(ValueError, "claimed Tasks"):
            publication.operations(value, data)

    def test_requirement_uses_each_criteria_test_list_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            (Path(directory) / "checks.rs").write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            data["joppa"].update(scope="requirement", tasks=[], criteria=[], criterion_schemas={})
            value.update(disposition="verify_existing", tasks=[], criteria=[], acceptance_checks=[])
            for address, revision in (("criterion:a", 4), ("criterion:b", 9)):
                data["joppa"]["criteria"].append({"id": address})
                data["joppa"]["objects"][address] = context.source(item(address, "rule:r"))
                detail = {key: deepcopy(data["joppa"][key]) for key in ("task_type", "task_schema", "test_status")}
                detail["test_status"].update(address=address, tests_revision=revision)
                data["joppa"]["criterion_schemas"][address] = detail
                value["criteria"].append({"ac": address, "disposition": "verify_existing"})
                value["acceptance_checks"].append({"ac": address, "repository": "service", "scenario": "Existing behavior",
                    "expected": "Required result", "test": "checks.rs > required_behavior",
                    "evidence": "service:checks.rs:1; service:implementation.rs:1"})
            bindings = [operation["command"] for operation in publication.operations(value, data)
                        if operation["command"]["op"] == "set_ac_tests"]
            self.assertEqual([(command["target"], command["revision"]) for command in bindings],
                             [("criterion:a", 4), ("criterion:b", 9)])

    def test_requirement_mixes_implementation_and_existing_test_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            (Path(directory) / "checks.rs").write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
                criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                    for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
            data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
            value["criteria"] = [{"ac": "criterion:a", "disposition": "implement"},
                                 {"ac": "criterion:b", "disposition": "verify_existing"}]
            value["acceptance_checks"][0]["ac"] = "criterion:a"
            value["acceptance_checks"].append({"ac": "criterion:b", "repository": "service", "scenario": "Existing behavior",
                "expected": "Required result", "test": "checks.rs > required_behavior",
                "evidence": "service:checks.rs:1; service:implementation.rs:1"})
            ops = publication.operations(value, data)
            self.assertEqual([op["command"]["op"] for op in ops],
                             ["save_object", "set_ac_tests", "finish_planning", "finish_planning"])
            self.assertEqual(ops[1]["command"]["target"], "criterion:b")
            self.assertEqual(ops[0]["command"]["parent"], "criterion:a")
