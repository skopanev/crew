"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
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
        {"assignee": "worker", "status": "in_progress", "done": None, "retired": None}))
    task["document"]["links"] = [{"target": "record:note", "relation": "related", "revision": 3, "blocking": False}]
    ac = context.source(item("criterion:a", "rule:r"))
    dependency = context.source(item("work:dependency", "criterion:b"))
    return {"workspace": "example", "ac": {"id": "criterion:a"},
            "repositories": [{"id": "service", "project": "project:p", "path": "/tmp/example-source",
                              "cbm_project": "service", "modules": [{"name": "core", "path": "src"}]}],
            "joppa": {"task_type": "work", "task_schema": {"question": "What work?", "title_preview_length": 64},
                      "tasks": [task], "objects": {"criterion:a": ac, "work:old": task, "work:dependency": dependency}}}


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
        self.assertTrue(set(calls).issubset({"joppa_tree", "joppa_read", "joppa_objects"}))
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

    def test_verification_creates_scoped_work_not_acceptance(self):
        value = plan()
        value["disposition"] = "verify_existing"
        with self.assertRaisesRegex(ValueError, "verification work only"):
            publication.operations(value, assignment())
        value["tasks"][0]["purpose"] = "verification"
        ops = publication.operations(value, assignment())
        self.assertEqual(ops[0]["command"]["data"]["purpose"], "implementation")
        self.assertIn("Checks:", ops[0]["command"]["data"]["contract"])
        self.assertEqual(ops[-1]["command"]["op"], "finish_planning")
        self.assertFalse(any(op["command"]["op"] in ("result", "accept", "complete_task") for op in ops))

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
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner"}))
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
            (target / "claim.json").write_text(json.dumps({"status": "confirmed", "result": {"position": 22}, "actor": "planner"}))
            api = Fake(result={"process": {"planning_claim": {"actor": "other", "position": 22}}})
            with self.assertRaisesRegex(ValueError, "does not hold"):
                publication.release(api, target, "example", "criterion:a", "Failure")
            self.assertEqual(len(api.calls), 1)
            api = Fake(result={"process": {"planning_claim": {"actor": "planner", "position": 22}}})
            self.assertTrue(publication.release(api, target, "example", "criterion:a", "Failure"))
            self.assertEqual(api.calls[-1][1]["command"]["op"], "release_planning")
            self.assertEqual(read(target / "release.json")["status"], "confirmed")

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
