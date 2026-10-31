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
        roster = ["criterion:archived", "criterion:a", "criterion:b", "criterion:c"]
        objects["criterion:archived"] = item("criterion:archived", "rule:r")
        objects["criterion:archived"]["document"]["present"] = False
        class Server:
            def call(self, name, args):
                if name == "joppa_tree":
                    return {"position": 20, "schema": {"types": deepcopy(types)}}
                if name == "joppa_tests":
                    rows = [{"address": address, "status": "grey", "tests_draft": False,
                             "tests_revision": None} for address in args["ac"].split(",")]
                    return rows[0] if len(rows) == 1 else {"items": rows}
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                if args.get("parent") == "rule:r":
                    return {"items": [{"address": address, "kind": "criterion",
                                       "present": objects[address]["document"]["present"]} for address in roster]}
                return {"items": []}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        data, snapshot, requirement = context.load_requirement(Server(), config, "r")
        self.assertEqual(requirement["address"], "rule:r")
        self.assertEqual([entry["id"] for entry in data["joppa"]["criteria"]], ["criterion:a"])
        self.assertEqual(snapshot["criteria"], ["criterion:a"])
        self.assertNotIn("criterion:archived", snapshot["objects"])
        objects["criterion:outside"]["current_revision"] = 4
        objects["criterion:outside"]["contract_revision"] = 3
        original_server_call = Server.call
        def green_outside(self, name, args):
            if name == "joppa_tests" and args.get("ac") == "criterion:outside":
                return {"address": "criterion:outside", "status": "green"}
            return original_server_call(self, name, args)
        with patch.object(Server, "call", green_outside):
            ready, _, _ = context.load_requirement(Server(), config, "r")
            self.assertIn("criterion:b", [entry["id"] for entry in ready["joppa"]["criteria"]])
            objects["criterion:outside"]["contract_revision"] = 4
            stale, _, _ = context.load_requirement(Server(), config, "r")
            self.assertNotIn("criterion:b", [entry["id"] for entry in stale["joppa"]["criteria"]])
            objects["criterion:b"]["document"]["links"][0].pop("revision")
            unpinned, _, _ = context.load_requirement(Server(), config, "r")
            self.assertIn("criterion:b", [entry["id"] for entry in unpinned["joppa"]["criteria"]])
            objects["criterion:b"]["document"]["links"][0]["revision"] = 3
        objects["criterion:outside"]["current_revision"] = 3
        del objects["criterion:outside"]["contract_revision"]
        with self.assertRaisesRegex(ValueError, "object is absent"):
            context.load(Server(), config, "criterion:archived")
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
        objects["criterion:a"]["document"]["links"] = [
            {"target": "criterion:archived", "revision": 3, "relation": "depends_on", "blocking": True}]
        with self.assertRaisesRegex(ValueError, "object is absent"):
            context.load_requirement(Server(), config, "r", ["criterion:a"])

    def test_context_reads_actual_revision_shape_and_custom_roles(self):
        ac = item("criterion:a", "rule:r")
        ac["document"]["data"]["body"] = "Given the input, return the required output."
        req = item("rule:r", "area:capability")
        cap = item("area:capability", "area:domain")
        dom = item("area:domain")
        project = item("project:p")
        existing = item("work:one", "criterion:a", process={"status": "in_progress", "assignee": "worker"})
        for obj, display_id in ((ac, "example-A-CRITERION"), (req, "example-R-REQUIREMENT"),
                                (existing, "example-T-EXISTING")):
            obj["item_id"] = display_id
        objects = {obj["address"]: obj for obj in (ac, req, cap, dom, project, existing)}
        types = {"criterion": {"role": "ac"}, "rule": {"role": "requirement"}, "area": {"role": "group"},
                 "project": {"role": "document"}, "work": {"role": "task", "parents": ["criterion"],
                    "question": "What work?", "references": {"projects": {"multiple": True, "target": "project"}}}}
        tree = {"position": 20, "schema": {"revision": 2, "types": types}}
        req["document"]["data"]["body"] = "Required behavior"
        req.pop("annotations")
        req["comments"] = {"items": [{"id": "decision", "text": "Approved"}]}
        calls = []
        class Reader:
            def call(self, tool, args):
                calls.append(tool)
                if tool == "joppa_tree":
                    return deepcopy(tree)
                if tool == "joppa_tests":
                    return deepcopy(assignment()["joppa"]["test_status"])
                if "address" in args:
                    return deepcopy(objects[args["address"]])
                if args.get("related_to"):
                    return {"items": []}
                if args.get("parent") == "rule:r":
                    return {"items": [{"address": "criterion:a", "kind": "criterion", "present": True}]}
                return {"items": [{"address": "work:one"}]}
        config = {"workspace": "example", "repositories": assignment()["repositories"]}
        value, snapshot, criterion = context.load(Reader(), config, "a")
        self.assertEqual(criterion["address"], "criterion:a")
        self.assertEqual(value["knowledge_query"], ac["document"]["data"]["body"])
        self.assertEqual(value["joppa"]["task_type"], "work")
        self.assertEqual(value["requirement"]["revision"], 3)
        self.assertEqual(snapshot["requirement"]["number"], 3)
        self.assertEqual(snapshot["requirement"]["comments"], {"decision": {"id": "decision", "text": "Approved"}})
        self.assertEqual(snapshot["requirement"]["body"], "Required behavior")
        self.assertNotIn("tasks", snapshot["requirement"])
        self.assertEqual(len(value["joppa"]["tasks"]), 1)
        self.assertEqual(json.loads(value["ac"]["text"])["item_id"], ac["item_id"])
        self.assertEqual(json.loads(value["requirement"]["text"])["item_id"], req["item_id"])
        self.assertEqual(value["joppa"]["tasks"][0]["item_id"], existing["item_id"])
        for obj in (ac, req, existing):
            self.assertEqual(value["joppa"]["objects"][obj["address"]]["item_id"], obj["item_id"])
            legacy = deepcopy(obj)
            legacy.pop("item_id")
            self.assertEqual(context.snapshot_source(obj, types, ac["address"]),
                             context.snapshot_source(legacy, types, ac["address"]))
        spec = importlib.util.spec_from_file_location("joppa_prompt_projection", ROOT / "planning-joppa/stages.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        with patch.object(stage.shared, "artifacts", return_value=Path("/unused")):
            prompt = stage.prompt_assignment(value)
            self.assertEqual(prompt["ac"]["item_id"], ac["item_id"])
            self.assertEqual(prompt["requirement"]["item_id"], req["item_id"])
            self.assertEqual(prompt["joppa"]["tasks"][0]["item_id"], existing["item_id"])
            grouped = deepcopy(value)
            grouped["joppa"].update(scope="requirement", criteria=[value["ac"]], criterion_schemas={})
            self.assertEqual(stage.prompt_assignment(grouped)["joppa"]["criteria"][0]["item_id"], ac["item_id"])
        self.assertTrue(set(calls).issubset({"joppa_tree", "joppa_objects", "joppa_tests"}))

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
        objects["criterion:b"]["document"]["present"] = False
        context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:a": own})
        with self.assertRaisesRegex(ValueError, "another Requirement criterion"):
            context.planning_idle(Server(), {"workspace": "example"}, data, {"criterion:b": own})

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
