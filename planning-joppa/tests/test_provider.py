"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
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
from mcp import MCPError, Rejected
import publication


def item(address, parent=None, data=None, process=None, role=None):
    return {"address": address, "kind": address.split(":")[0], "id": address.split(":")[1],
            "current_revision": 3, "document": {"present": True, "data": data or {"title": address, "owner": "owner"},
             "parent": parent, "links": [], "revision": 3, "actor": "document-owner", "position": 10},
            "process": process or {}, "annotations": {"comments": []}, "files": [], "references": [],
            "position": 20, "historical": False, "review_required": False, "work_ready": True}


def assignment():
    task = context.source(item("work:old", "criterion:a", {"title": "Existing", "owner": "document-owner",
        "purpose": "implementation", "contract": "Existing contract", "projects": ["other"], "custom": "preserve"},
        {"assignee": None, "status": "open", "done": None, "retired": None}))
    task["document"]["links"] = [{"target": "record:note", "relation": "related", "revision": 3, "blocking": False}]
    ac = context.source(item("criterion:a", "rule:r"))
    dependency = context.source(item("work:dependency", "criterion:b"))
    return {"workspace": "example", "ac": {"id": "criterion:a"},
            "repositories": [{"id": "service", "project": "project:p", "path": "/tmp/example-source",
                              "cbm_project": "service", "modules": [{"name": "core", "path": "src"}]}],
            "joppa": {"task_type": "work", "task_schema": {"question": "What work?", "title_preview_length": 64},
                      "tasks": [task], "objects": {"criterion:a": ac, "work:old": task, "work:dependency": dependency},
                      "test_status": {"address": "criterion:a", "tests": [], "tests_draft": False,
                                      "tests_revision": None}}}


def plan():
    task = {"id": "first", "action": "create", "ac": "criterion:a", "title": "Create a mechanism",
            "repository": "service", "module": "core", "outcome": "Observable output",
            "steps": ["Use the existing mechanism and reject invalid input."], "reuse": ["Existing mechanism"],
            "depends_on": [], "checks": [{"scenario": "Reject invalid input", "expected": "No mutation"}]}
    return {"disposition": "implement", "outcome": "Criterion output", "necessity": "Required work",
            "approach": "Use the existing mechanism", "rationale": "Minimum sufficient scope",
            "alternatives": ["Existing behavior does not supply the output"], "blockers": [],
            "acceptance_checks": [{"repository": "service", "scenario": "Criterion action", "expected": "Criterion output"}],
            "tasks": [task]}


class Fake:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def call(self, name, args):
        self.calls.append((name, deepcopy(args)))
        if self.error:
            raise self.error
        return self.result


class ProviderTests(unittest.TestCase):
    def test_direct_ac_filter_refuses_before_claim(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_filter", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        data = assignment()
        api = Fake(result={"commands": ["claim_planning", "finish_planning", "release_planning"]})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PLANNING_JOPPA_AC": "criterion:a"}, clear=False), \
             patch.object(stage, "settings", return_value={"workspace": "example", "ac_ids": ["criterion:b"]}), \
             patch.object(stage, "reader_servers"), patch.object(stage.context, "client", return_value=api), \
             patch.object(stage.context, "load", return_value=(data, {}, data["joppa"]["objects"]["criterion:a"])), \
             patch.object(stage.shared, "artifacts", return_value=Path(directory)):
            with self.assertRaisesRegex(ValueError, "outside config.ac_ids"):
                stage.prepare()
        self.assertEqual([name for name, _ in api.calls], ["joppa_help"])

    def test_requirement_claim_guard_checks_siblings_and_exact_own_receipt(self):
        data = assignment()
        data["decisions"] = [json.dumps({"acs": [{"id": "criterion:a"}, {"id": "criterion:b"}]})]
        own = {"actor": "planner", "position": 22}
        objects = {address: item(address, "rule:r") for address in ("criterion:a", "criterion:b")}
        objects["criterion:a"]["process"]["planning_claim"] = {**own, "future_metadata": "allowed"}
        objects["criterion:b"]["process"]["planning_claim"] = {"actor": "other", "position": 23}
        class Server:
            def call(self, name, args):
                return deepcopy(objects[args["address"]])
        with self.assertRaisesRegex(ValueError, "active planning run"):
            context.planning_idle(Server(), {"workspace": "example"}, data)
        with self.assertRaisesRegex(ValueError, "active planning run on criterion:b"):
            context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": own})
        objects["criterion:b"]["process"].pop("planning_claim")
        context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": own})
        with self.assertRaisesRegex(ValueError, "no longer holds"):
            context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": {**own, "position": 24}})

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
        data["joppa"]["tasks"] = [old]
        value["tasks"][0].update(action="update", target="work:old", revision=3, depends_on=[])
        retained["document"]["links"] = [{"target": "work:old", "revision": 3, "relation": "depends_on", "blocking": True}]
        with self.assertRaisesRegex(ValueError, "retained Task work:retained requires planned Task work:old"):
            publication.operations(value, data)

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

    def test_partial_release_recovery_stays_bound_to_the_unreadable_criterion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, current = root / "older/artifacts", root / "current/artifacts"
            old.mkdir(parents=True)
            current.mkdir(parents=True)
            (old / "claim.json").write_text(json.dumps({"status": "confirmed", "server": "https://example.invalid/mcp",
                "arguments": {"workspace": "example", "operations": [
                    {"command": {"op": "claim_planning", "ac": address}} for address in ("criterion:a", "criterion:b")]}}))
            release = {"status": "confirmed", "released": ["criterion:b"],
                       "skipped_claims": [{"ac": "criterion:a", "unknown": True, "reason": "planning claim could not be read"}]}
            (old / "release.json").write_text(json.dumps(release))
            def check(address):
                publication.ensure_recovered(root, current, "https://example.invalid/mcp", "example", address)
            with self.assertRaisesRegex(ValueError, "claim or publication needs recovery"):
                check("criterion:a")
            check("criterion:b")
            release["skipped_claims"][0].pop("unknown")
            release["skipped_claims"][0]["reason"] = "planning claim is missing or replaced"
            (old / "release.json").write_text(json.dumps(release))
            check("criterion:a")

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

    def test_requirement_claim_release_is_atomic_and_checks_every_holder(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            receipt = {"status": "confirmed", "holders": {"criterion:a": "planner", "criterion:b": "planner"},
                "arguments": {"workspace": "example", "operations": [
                    {"command": {"op": "claim_planning", "ac": address, "revision": 3}}
                    for address in ("criterion:a", "criterion:b")]},
                "result": {"results": [{"position": 22}, {"position": 23}]}}
            (target / "claim.json").write_text(json.dumps(receipt))
            class Server(Fake):
                def call(self, name, args):
                    self.calls.append((name, deepcopy(args)))
                    if name == "joppa_objects":
                        return {"process": {"planning_claim": {"actor": "planner", "position":
                            22 if args["address"] == "criterion:a" else 23}}}
                    return {"results": [{"position": 24}, {"position": 25}]}
            api = Server()
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            name, arguments = api.calls[-1]
            self.assertEqual(name, "joppa_batch")
            self.assertEqual([entry["command"]["ac"] for entry in arguments["operations"]],
                             ["criterion:a", "criterion:b"])
            self.assertEqual(read(target / "release.json")["status"], "confirmed")
            (target / "release.json").unlink()
            class Replaced(Server):
                def call(self, name, args):
                    result = super().call(name, args)
                    if name == "joppa_objects" and args["address"] == "criterion:b":
                        result["process"]["planning_claim"] = {"actor": "another-planner", "position": 26}
                    return result
            api = Replaced()
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual([entry["command"]["ac"] for entry in api.calls[-1][1]["operations"]], ["criterion:a"])
            release = read(target / "release.json")
            self.assertEqual(release["released"], ["criterion:a"])
            self.assertEqual(release["skipped_claims"][0]["ac"], "criterion:b")
            with self.assertRaisesRegex(ValueError, "does not hold"):
                publication.held_claims(api, "example", receipt)
            (target / "release.json").unlink()
            class Uncertain(Server):
                def call(self, name, args):
                    if name == "joppa_batch":
                        raise MCPError("release response lost")
                    return super().call(name, args)
            with self.assertRaisesRegex(MCPError, "response lost"):
                publication.release(Uncertain(), target, "example", "criterion:a", "Failure")
            uncertain = read(target / "release.json")
            self.assertEqual(uncertain["status"], "uncertain")
            self.assertEqual(uncertain["released"], [])
            self.assertEqual(uncertain["requested_releases"], ["criterion:a", "criterion:b"])
            (target / "release.json").unlink()
            class Unreadable(Server):
                def call(self, name, args):
                    if name == "joppa_objects" and args["address"] == "criterion:a":
                        raise MCPError("claim read failed")
                    return super().call(name, args)
            api = Unreadable()
            self.assertFalse(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(read(target / "release.json")["released"], ["criterion:b"])
            self.assertTrue(read(target / "release.json")["skipped_claims"][0]["unknown"])
            self.assertEqual([entry["command"]["ac"] for entry in api.calls[-1][1]["operations"]], ["criterion:b"])
            previous_calls = len(api.calls)
            self.assertFalse(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(len(api.calls), previous_calls)

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

    def test_capture_rejects_an_oversized_publication_before_critics(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_size", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        data, value = assignment(), plan()
        data["joppa"].update(scope="requirement", tasks=[], criteria=[{"id": "criterion:a"}, {"id": "criterion:b"}],
            criterion_schemas={address: {key: deepcopy(data["joppa"][key])
                for key in ("task_type", "task_schema", "test_status")} for address in ("criterion:a", "criterion:b")})
        data["joppa"]["objects"]["criterion:b"] = context.source(item("criterion:b", "rule:r"))
        value["criteria"] = [{"ac": address, "disposition": "implement"} for address in ("criterion:a", "criterion:b")]
        value["acceptance_checks"] = [{**deepcopy(value["acceptance_checks"][0]), "ac": address}
                                      for address in ("criterion:a", "criterion:b")]
        first = value["tasks"][0]
        value["tasks"] = [{**deepcopy(first), "id": f"task{number}", "ac": "criterion:a" if number < 50 else "criterion:b"}
                          for number in range(100)]
        api = Fake()
        with tempfile.TemporaryDirectory() as directory, patch.object(stage, "settings", return_value={"workspace": "example"}), \
             patch.object(stage.context, "client", return_value=api), patch.object(stage.context, "read_assignment", return_value=data), \
             patch.object(stage.shared, "artifacts", return_value=Path(directory)), \
             patch.object(stage.shared, "body_result", return_value=(value, [])), \
             patch.object(stage.shared, "bind_necessity") as necessity:
            with self.assertRaisesRegex(ValueError, "100 operations"):
                stage.capture("plan")
            necessity.assert_not_called()
            self.assertFalse((Path(directory) / "plan.json").exists())
        self.assertEqual(api.calls, [])

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

    def test_requirement_selection_excludes_unmet_external_dependencies(self):
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "project": {"role": "document"},
                 "work": {"role": "task", "parents": ["criterion"], "question": "What work?",
                          "references": {"projects": {"multiple": True, "target": "project"}}}}
        objects = {address: item(address, "rule:r") for address in ("criterion:a", "criterion:b", "criterion:c")}
        for object in objects.values():
            object["process"]["assessment"] = {"state": "ready"}
        objects.update({"rule:r": item("rule:r"), "project:p": item("project:p"),
                        "criterion:outside": item("criterion:outside", "rule:outside"),
                        "rule:outside": item("rule:outside")})
        objects["criterion:b"]["document"]["links"] = [
            {"target": "criterion:outside", "revision": 3, "relation": "depends_on", "blocking": True}]
        objects["criterion:c"]["document"]["links"] = [
            {"target": "criterion:a", "revision": 3, "relation": "depends_on", "blocking": True}]
        detail = {"position": 20, "requirement": {"current_revision": 3, "revisions": [{"number": 3,
            "acs": [{"id": address} for address in ("criterion:a", "criterion:b", "criterion:c")]}]}}
        class Server:
            def call(self, name, args):
                if name == "joppa_tree":
                    return {"position": 20, "schema": {"types": deepcopy(types)}}
                if name == "joppa_read":
                    return deepcopy(detail)
                if name == "joppa_tests":
                    rows = [{"address": address, "status": "grey", "tests": [], "tests_draft": False,
                             "tests_revision": None} for address in args["ac"].split(",")]
                    return rows[0] if len(rows) == 1 else {"items": rows}
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                return {"position": 20, "items": [], "next_cursor": None}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        data, snapshot, requirement = context.load_requirement(Server(), config, "r")
        self.assertEqual(requirement["address"], "rule:r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a"])
        self.assertEqual(snapshot["criteria"], ["criterion:a"])
        config["ac_ids"] = ["criterion:c"]
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(Server(), config, "r")
        original_links = objects["criterion:c"]["document"]["links"]
        objects["criterion:c"]["document"]["links"] = []
        filtered, _, _ = context.load_requirement(Server(), config, "r")
        self.assertEqual([entry["id"] for entry in filtered["joppa"]["criteria"]], ["criterion:c"])
        config.pop("ac_ids")
        objects["criterion:c"]["document"]["links"] = original_links
        objects["criterion:a"]["process"]["planning_claim"] = {"actor": "planner", "position": 21}
        with self.assertRaisesRegex(ValueError, "no ready criteria"):
            context.load_requirement(Server(), config, "r")
        resumed, _, _ = context.load_requirement(Server(), config, "r", ["criterion:a"])
        self.assertEqual([entry["id"] for entry in resumed["joppa"]["criteria"]], ["criterion:a"])

    def test_retirement_uses_the_existing_atomic_publication(self):
        data, value = assignment(), plan()
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
        value["tasks"][0].update(action="retire", target="work:old", revision=3,
                                 outcome="The approved outcome needs no further work.")
        original = deepcopy(data)
        commands = publication.operations(value, data)
        self.assertEqual([item["command"]["op"] for item in commands], ["retire_task", "finish_planning"])
        self.assertEqual(commands[0]["command"], {"op": "retire_task", "id": "old", "revision": 3,
                                                  "reason": value["tasks"][0]["outcome"]})
        self.assertEqual(data, original)

    def test_retirement_accepts_a_blocked_verification_task(self):
        data, value = assignment(), plan()
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
        data["joppa"]["tasks"][0]["document"]["data"]["purpose"] = "verification"
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        self.assertEqual(publication.operations(value, data)[0]["command"]["op"], "retire_task")

    def test_retirement_requires_existing_dependents_to_remove_the_link(self):
        data, value = assignment(), plan()
        data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
        value["tasks"][0].update(action="retire", target="work:old", revision=3)
        consumer = deepcopy(data["joppa"]["tasks"][0])
        consumer["address"] = "work:consumer"
        consumer["document"]["links"].append(
            {"target": "work:old", "relation": "depends_on", "blocking": True, "revision": 3})
        consumer["document"]["links"].append(
            {"target": "work:dependency", "relation": "depends_on", "blocking": True, "revision": 3})
        data["joppa"]["tasks"].append(consumer)
        data["joppa"]["objects"][consumer["address"]] = consumer
        with self.assertRaisesRegex(ValueError, "removes the dependency from work:consumer"):
            publication.operations(value, data)
        changed = deepcopy(plan()["tasks"][0])
        changed.update(id="consumer", action="update", target="work:consumer", revision=3, depends_on=[])
        value["tasks"].append(changed)
        commands = publication.operations(value, data)
        self.assertEqual([item["command"]["op"] for item in commands],
                         ["retire_task", "save_object", "finish_planning"])
        links = commands[1]["command"]["links"]
        self.assertFalse(any(link["target"] == "work:old" for link in links))
        self.assertTrue(any(link["target"] == "work:dependency" for link in links))
        self.assertTrue(any(link["target"] == "record:note" for link in links))

    def test_retirement_preserves_finished_dependents(self):
        for field, setting in (("done", "Evidence"), ("retired", {"reason": "Old"})):
            with self.subTest(field=field):
                data, value = assignment(), plan()
                data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
                value["tasks"][0].update(action="retire", target="work:old", revision=3)
                consumer = deepcopy(data["joppa"]["tasks"][0])
                consumer["address"] = "work:consumer"
                consumer["process"][field] = setting
                consumer["document"]["links"].append(
                    {"target": "work:old", "relation": "depends_on", "blocking": True, "revision": 3})
                data["joppa"]["tasks"].append(consumer)
                original = deepcopy(data)
                commands = publication.operations(value, data)
                self.assertEqual([item["command"]["op"] for item in commands], ["retire_task", "finish_planning"])
                self.assertEqual(data, original)

    def test_retirement_refuses_unsafe_targets_and_dependency_use(self):
        data, value = assignment(), plan()
        task = value["tasks"][0]
        task.update(action="retire", target="work:old", revision=3)
        blocked = data["joppa"]["tasks"][0]
        blocked["process"]["blocked"] = {"reason": "Failed", "position": 19}
        for field, setting in (("blocked", None), ("assignee", "worker"),
                               ("claim", {"actor": "worker"}), ("status", "in_progress"),
                               ("done", "Evidence"), ("retired", {"reason": "Old"})):
            with self.subTest(field=field):
                changed = deepcopy(data)
                changed["joppa"]["tasks"][0]["process"][field] = setting
                with self.assertRaises(ValueError):
                    publication.operations(value, changed)
        stale = deepcopy(value)
        stale["tasks"][0]["revision"] = 2
        with self.assertRaisesRegex(ValueError, "source revision"):
            publication.operations(stale, data)
        for dependency in ("first", "work:old"):
            consumer = deepcopy(plan()["tasks"][0])
            consumer.update(id="consumer", depends_on=[dependency])
            mixed = deepcopy(value)
            mixed["tasks"].append(consumer)
            with self.assertRaisesRegex(ValueError, "retired by this plan"):
                publication.operations(mixed, data)
        task["depends_on"] = ["work:dependency"]
        with self.assertRaisesRegex(ValueError, "retirement cannot add dependencies"):
            publication.operations(value, data)

    def test_context_reads_actual_revision_shape_and_custom_roles(self):
        ac = item("criterion:a", "rule:r")
        req = item("rule:r", "area:capability")
        cap = item("area:capability", "area:domain")
        dom = item("area:domain")
        project = item("project:p")
        existing = item("work:one", "criterion:a", process={"status": "in_progress", "assignee": "worker"})
        objects = {obj["address"]: obj for obj in (ac, req, cap, dom, project, existing)}
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "area": {"role": "group"},
                 "project": {"role": "document"}, "work": {"role": "task", "parents": ["criterion"],
                    "question": "What work?", "references": {"projects": {"multiple": True, "target": "project"}}}}
        tree = {"position": 20, "schema": {"revision": 2, "types": types}}
        detail = {"position": 20, "requirement": {"current_revision": 7,
                   "revisions": [{"number": 7, "body": "Required behavior", "tasks": {"runtime": "summary"},
                                  "runs": {}, "confirmed": True}], "comments": {"decision": "Approved"}}}
        calls = []
        class Reader:
            def call(self, tool, args):
                calls.append(tool)
                if tool == "joppa_tree":
                    return deepcopy(tree)
                if tool == "joppa_read":
                    return deepcopy(detail)
                if tool == "joppa_tests":
                    return deepcopy(assignment()["joppa"]["test_status"])
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                return {"position": 20, "items": [{"address": "work:one"}], "next_cursor": None}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, snapshot, criterion = context.load(Reader(), config, "a")
        self.assertEqual(criterion["address"], "criterion:a")
        self.assertEqual(value["joppa"]["task_type"], "work")
        self.assertEqual(value["requirement"]["revision"], 3)
        self.assertEqual(snapshot["requirement"]["number"], 7)
        self.assertEqual(snapshot["requirement"]["comments"], {"decision": "Approved"})
        self.assertNotIn("tasks", snapshot["requirement"])
        self.assertEqual(len(value["joppa"]["tasks"]), 1)
        self.assertTrue(set(calls).issubset({"joppa_tree", "joppa_read", "joppa_objects", "joppa_tests"}))
        detail["requirement"]["current_revision"] = 8
        with self.assertRaisesRegex(ValueError, "another revision"):
            context.load(Reader(), config, "a")

    def test_update_dependencies_replace_old_edges_before_reference_resolution(self):
        data = assignment()
        prerequisite = deepcopy(data["joppa"]["tasks"][0])
        prerequisite["address"] = "work:prerequisite"
        data["joppa"]["tasks"].append(prerequisite)
        data["joppa"]["objects"][prerequisite["address"]] = prerequisite
        data["joppa"]["tasks"][0]["document"]["links"].append(
            {"target": "work:prerequisite", "revision": 2, "relation": "depends_on", "blocking": True})
        for reference in ("work:prerequisite", "prerequisite"):
            value = plan()
            consumer = value["tasks"][0]
            consumer.update(action="update", target="work:old", revision=3, depends_on=[reference])
            provider = deepcopy(consumer)
            provider.update(id="prerequisite", target="work:prerequisite", depends_on=[])
            value["tasks"] = [consumer, provider]
            commands = publication.operations(value, data)
            dependencies = [link for link in commands[1]["command"]["links"] if link["relation"] == "depends_on"]
            self.assertEqual(len(dependencies), 1)
            self.assertEqual(dependencies[0]["target"], {"$ref": "task1/address"})

    def test_reversed_dependency_order_and_cycles(self):
        value = plan()
        first = value["tasks"][0]
        consumer = deepcopy(first)
        consumer.update(id="consumer", title="Consume the output", depends_on=["first"])
        value["tasks"] = [consumer, first]
        operations = publication.operations(value, assignment())
        self.assertEqual(operations[0]["command"]["data"]["title"], "Create a mechanism")
        self.assertEqual(operations[1]["command"]["data"]["title"], "Consume the output")
        self.assertEqual(operations[1]["command"]["links"][0]["target"], {"$ref": "task1/address"})
        first["depends_on"] = ["consumer"]
        with self.assertRaisesRegex(ValueError, "contain a cycle"):
            publication.operations(value, assignment())

    def test_atomic_references_and_worker_preservation(self):
        data = assignment()
        original = deepcopy(data)
        value = plan()
        second = deepcopy(value["tasks"][0])
        second.update(id="second", action="update", target="work:old", revision=3,
                      depends_on=["first", "work:dependency"])
        value["tasks"].append(second)
        ops = publication.operations(value, data)
        self.assertEqual([op["command"]["op"] for op in ops], ["save_object", "save_object", "finish_planning"])
        saved = ops[1]["command"]
        self.assertEqual(saved["data"]["owner"], "document-owner")
        self.assertEqual(saved["data"]["custom"], "preserve")
        self.assertEqual(saved["data"]["projects"], ["other", "p"])
        self.assertNotIn("assignee", saved)
        self.assertNotIn("status", saved)
        self.assertEqual(saved["question_checked"], "What work?")
        self.assertIn({"target": {"$ref": "task1/address"}, "revision": {"$ref": "task1/saved_revision"},
                       "relation": "depends_on", "blocking": True}, saved["links"])
        self.assertIn({"target": "work:dependency", "revision": 3, "relation": "depends_on", "blocking": True}, saved["links"])
        self.assertIn("1. Use the existing mechanism", saved["data"]["contract"])
        self.assertEqual(data, original)

    def test_refuses_occupied_and_human_work(self):
        value = plan()
        value["tasks"][0].update(action="update", target="work:old", revision=3)
        for field, setting in (("assignee", "worker"), ("claim", {"actor": "worker"}), ("status", "in_progress")):
            data = assignment()
            data["joppa"]["tasks"][0]["process"][field] = setting
            with self.assertRaisesRegex(ValueError, "claimed Tasks"):
                publication.operations(value, data)
        for purpose in ("decision", "manual", "custom"):
            data = assignment()
            data["joppa"]["tasks"][0]["document"]["data"]["purpose"] = purpose
            with self.assertRaisesRegex(ValueError, "only implementation"):
                publication.operations(value, data)

    def test_noop_prerequisite_keeps_fresh_reference_without_save(self):
        data = assignment()
        value = plan()
        first = value["tasks"][0]
        first.update(action="update", target="work:old", revision=3)
        original = data["joppa"]["tasks"][0]
        original["document"]["data"].update(title=first["title"], contract=publication.contract(first, value),
                                             projects=["other", "p"])
        second = deepcopy(first)
        second.update(id="consumer", action="create", title="Consume existing work", depends_on=["first"])
        del second["target"], second["revision"]
        value["tasks"].append(second)
        commands = publication.operations(value, data)
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0]["command"]["data"]["title"], "Consume existing work")
        self.assertIn({"target": "work:old", "revision": 3, "relation": "depends_on", "blocking": True},
                      commands[0]["command"]["links"])
        value["tasks"] = [first]
        self.assertEqual([x["command"]["op"] for x in publication.operations(value, data)], ["finish_planning"])

    def test_restart_refuses_unresolved_receipts_for_the_same_ac(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "old" / "artifacts"
            old.mkdir(parents=True)
            claim = {"status": "confirmed", "server": "https://one.example/mcp", "arguments": {
                "workspace": "example", "command": {"ac": "criterion:a"}}, "result": {"position": 22}}
            (old / "claim.json").write_text(json.dumps(claim))
            (old / "publication.json").write_text(json.dumps({"status": "uncertain"}))
            current = root / "new" / "artifacts"
            check = lambda url="https://one.example/mcp", ac="criterion:a": publication.ensure_recovered(
                root, current, url, "example", ac)
            with self.assertRaisesRegex(ValueError, "receipt recovery"):
                check()
            check("https://two.example/mcp")
            check(ac="criterion:b")
            (old / "publication.json").write_text(json.dumps({"status": "confirmed"}))
            with self.assertRaisesRegex(ValueError, "publication needs recovery"):
                check()
            (old / "result.json").write_text(json.dumps({"status": "published"}))
            check()
            (old / "publication.json").unlink()
            (old / "result.json").unlink()
            with self.assertRaisesRegex(ValueError, "claim or publication"):
                check()
            (old / "release.json").write_text(json.dumps({"status": "confirmed"}))
            check()

    def test_existing_coverage_does_not_create_verification_work(self):
        value = plan()
        value["disposition"] = "verify_existing"
        with self.assertRaisesRegex(ValueError, "must not create verification work"):
            publication.operations(value, assignment())
        value["tasks"] = []
        with self.assertRaisesRegex(ValueError, "acceptance_check.test"):
            publication.operations(value, assignment())

    def test_binding_preserves_the_list_and_skips_an_unchanged_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            (Path(directory) / "checks").mkdir()
            test = Path(directory) / "checks/checks.rs"
            test.write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            value.update(disposition="verify_existing", tasks=[])
            value["acceptance_checks"][0].update(test="checks/checks.rs > required_behavior",
                evidence="service:checks/checks.rs:1; service:implementation.rs:1")
            status = data["joppa"]["test_status"]
            status.update(tests=[{"address": "checks/checks.rs > other"}], tests_revision=4)
            ops = publication.operations(value, data)
            self.assertEqual([op["command"]["op"] for op in ops], ["set_ac_tests", "finish_planning"])
            self.assertEqual(ops[0]["command"]["tests"], ["checks/checks.rs > other", "checks/checks.rs > required_behavior"])
            self.assertEqual(ops[0]["command"]["revision"], 4)
            status["tests"].append({"address": "checks/checks.rs > required_behavior"})
            self.assertEqual(len(publication.operations(value, data)), 1)
            status["tests_draft"] = True
            self.assertEqual(len(publication.operations(value, data)), 2)
            retire = deepcopy(plan()["tasks"][0])
            retire.update(action="retire", target="work:old", revision=3)
            data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
            value["tasks"] = [retire]
            self.assertEqual([op["command"]["op"] for op in publication.operations(value, data)],
                             ["retire_task", "set_ac_tests", "finish_planning"])

    def test_binding_requires_execution_evidence_and_unchanged_cited_source(self):
        from common import fingerprint
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            git = lambda *args: subprocess.check_output(["git", "-C", directory, *args], text=True).strip()
            git("init", "-q")
            (Path(directory) / "checks").mkdir()
            test = Path(directory) / "checks/checks.rs"
            test.write_text("assert!(required_behavior());\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            git("add", ".")
            git("-c", "user.name=proof", "-c", "user.email=proof@local", "commit", "-qm", "fixture")
            commit = git("rev-parse", "HEAD")
            value.update(disposition="verify_existing", tasks=[])
            value["acceptance_checks"][0].update(test="checks/checks.rs > required_behavior",
                evidence="service:checks/checks.rs:1; service:implementation.rs:1")
            row = {"address": "checks/checks.rs > required_behavior", "status": "pass", "commit": commit}
            data["joppa"]["test_status"]["tests"] = [row]
            snap = {"service": fingerprint(data["repositories"][0])}
            api = Fake(result=data["joppa"]["test_status"])
            publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            with self.assertRaisesRegex(ValueError, "snapshot is missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, {})
            row["status"] = "not_run"
            with self.assertRaisesRegex(ValueError, "passing result missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            row["status"] = "pass"
            (Path(directory) / "unrelated.txt").write_text("unrelated\n")
            git("add", ".")
            git("-c", "user.name=proof", "-c", "user.email=proof@local", "commit", "-qm", "unrelated")
            snap = {"service": fingerprint(data["repositories"][0])}
            publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            test.write_text("assert!(false);\n")
            git("add", ".")
            git("-c", "user.name=proof", "-c", "user.email=proof@local", "commit", "-qm", "changed assertion")
            snap = {"service": fingerprint(data["repositories"][0])}
            with self.assertRaises(ValueError):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)

    def test_rejects_stale_and_completed_updates_and_unknown_dependencies(self):
        value = plan()
        value["tasks"][0].update(action="update", target="work:old", revision=2)
        with self.assertRaisesRegex(ValueError, "source revision"):
            publication.operations(value, assignment())
        value["tasks"][0]["revision"] = 3
        data = assignment()
        data["joppa"]["tasks"][0]["process"]["done"] = {"evidence": "Complete"}
        with self.assertRaisesRegex(ValueError, "completed or retired"):
            publication.operations(value, data)
        value = plan()
        value["tasks"][0]["depends_on"] = ["work:unread"]
        with self.assertRaisesRegex(ValueError, "was not read"):
            publication.operations(value, assignment())

    def test_uncertain_publication_keeps_claim_and_never_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner", "arguments": {"workspace": "example", "command": {"op": "claim_planning", "ac": "criterion:a"}}}))
            api = Fake(error=MCPError("transport failed"))
            with self.assertRaises(MCPError):
                publication.mutate(api, target / "publication.json", "joppa_batch", {"workspace": "example", "operations": []})
            receipt = read(target / "publication.json")
            self.assertEqual(receipt["status"], "uncertain")
            self.assertTrue(receipt["arguments"]["request_id"])
            self.assertFalse(publication.release(api, target, "example", "criterion:a", "Failure"))
            with self.assertRaisesRegex(ValueError, "no automatic retry"):
                publication.mutate(api, target / "publication.json", "joppa_batch", {})
            self.assertEqual(len(api.calls), 1)

    def test_confirmed_failure_releases_only_the_same_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner", "arguments": {"workspace": "example", "command": {"op": "claim_planning", "ac": "criterion:a"}}}))
            api = Fake(result={"process": {"planning_claim": {"actor": "other", "position": 22}}})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(len(api.calls), 1)
            self.assertEqual(read(target / "release.json")["skipped_claims"][0]["ac"], "criterion:a")
            (target / "release.json").unlink()
            api = Fake(result={"process": {"planning_claim": {"actor": "planner", "position": 22}}})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(api.calls[-1][1]["command"]["op"], "release_planning")
            self.assertEqual(read(target / "release.json")["status"], "confirmed")

    def test_unchanged_blocked_task_keeps_the_planning_claim(self):
        spec = importlib.util.spec_from_file_location("joppa_stage_control", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        blocked_refusal = "blocked Task needs a new contract or retirement"
        for blocked, terminal, refusal in ((False, None, blocked_refusal), (True, None, blocked_refusal),
                (True, None, "planning produced no Task changes"),
                (True, "done", blocked_refusal), (True, "retired", blocked_refusal)):
            with self.subTest(blocked=blocked, terminal=terminal, refusal=refusal), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                data, value = assignment(), plan()
                task = value["tasks"][0]
                task.update(action="update", target="work:old", revision=3)
                existing = data["joppa"]["tasks"][0]
                existing["document"]["data"].update(title=task["title"], contract=publication.contract(task, value),
                                                     projects=["other", "p"])
                if blocked:
                    existing["process"]["blocked"] = {"reason": "Failed", "position": 19}
                if terminal:
                    finished = deepcopy(existing)
                    finished["address"] = "work:finished"
                    finished["process"][terminal] = {"reason": "Earlier work"}
                    data["joppa"]["tasks"].append(finished)
                    existing["process"].pop("blocked")
                active_blocked = blocked and terminal is None
                for name, body in {"input": data, "plan": value, "joppa-snapshot": {},
                    "claim": {"status": "confirmed", "actor": "planner", "result": {"position": 22}, "arguments": {"workspace": "example", "command": {"op": "claim_planning", "ac": "criterion:a"}}}}.items():
                    (target / f"{name}.json").write_text(json.dumps(body))
                class Server(Fake):
                    def call(self, name, args):
                        self.calls.append((name, deepcopy(args)))
                        if name == "joppa_objects":
                            return {"process": {"planning_claim": {"actor": "planner", "position": 22}}}
                        if name == "joppa_batch":
                            raise Rejected(refusal)
                        return {"position": 23}
                api = Server()
                with patch.object(stage, "settings", return_value={"workspace": "example"}), \
                     patch.object(stage.shared, "artifacts", return_value=target), \
                     patch.object(stage.shared, "verify_context", return_value=({}, {}, {})), \
                     patch.object(stage.context, "client", return_value=api), \
                     patch.object(stage.context, "read_assignment", return_value=data), \
                     patch.object(stage.context, "load", return_value=(data, {}, None)), \
                     patch.object(stage.context, "planning_idle"), \
                     patch.object(stage.context, "refresh_reads"), patch.object(stage, "signal"):
                    if active_blocked:
                        with self.assertRaisesRegex(Rejected, refusal):
                            stage.finish()
                        stage.fail(refusal)
                    else:
                        stage.finish()
                result = read(target / "result.json")
                self.assertEqual(result["claim_released"], not active_blocked)
                self.assertEqual(result["status"], "blocked" if active_blocked else "unchanged")
                self.assertEqual((target / "release.json").exists(), not active_blocked)
                if active_blocked:
                    self.assertTrue(result["needs_recovery"])
                    self.assertTrue(read(target / "publication.json")["retain_claim"])
                    mutations = [(name, args) for name, args in api.calls if name != "joppa_objects"]
                    self.assertEqual([name for name, args in mutations], ["joppa_batch"])
                    self.assertEqual(mutations[0][1]["operations"][0]["command"]["op"], "finish_planning")

    def test_server_rejection_retains_exact_reason(self):
        transport = object.__new__(__import__("mcp").Joppa)
        transport.token = "test-secret"
        transport.rpc = lambda *args: {"isError": True, "structuredContent": {"error": "stale object revision; read the object again"}}
        with self.assertRaisesRegex(Rejected, "stale object revision; read the object again"):
            transport.call("joppa_command", {})

    def test_source_claim_exclusion_and_authority_changes(self):
        old = item("criterion:a")
        current = deepcopy(old)
        current["position"] = 30
        current["process"]["planning_claim"] = {"actor": "planner", "position": 21}
        context.unchanged(context.source(old), context.source(current))
        current["annotations"]["comments"].append({"kind": "decision", "text": "New constraint"})
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(context.source(old), context.source(current))

    def test_snapshot_ignores_task_runtime_changes_but_preserves_contracts(self):
        old = item("work:one", process={"assignee": "worker", "status": "in_progress"})
        current = deepcopy(old)
        current["process"] = {"assignee": None, "status": "open"}
        current["current_revision"] = 4
        current["document"].update(revision=4, actor="worker", position=25, reason="Release the Task")
        types = {"work": {"role": "task"}}
        context.unchanged(context.snapshot_source(old, types), context.snapshot_source(current, types))
        current["document"]["data"]["title"] = "Changed contract"
        with self.assertRaisesRegex(ValueError, "context changed"):
            context.unchanged(context.snapshot_source(old, types), context.snapshot_source(current, types))

    def test_dry_run_uses_no_mcp_or_agents(self):
        result = subprocess.run([sys.executable, str(ROOT / "planning-joppa/launch.py"), "--config",
            str(ROOT / "planning-joppa/config.example.json"), "--ac-id", "criterion:a", "--dry-run"],
            env={**os.environ, "MEDULLA_BIN": "/unavailable/medulla"}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no MCP calls, claims, agents, or writes", result.stdout)


if __name__ == "__main__":
    unittest.main()
