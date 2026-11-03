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


from provider_fixture import item, assignment, plan, Fake, NodeServer
from test_nodes import bind_missing


class ProviderTests(unittest.TestCase):
    def test_existing_coverage_does_not_create_verification_work(self):
        value = plan()
        value["disposition"] = "verify_existing"
        with self.assertRaisesRegex(ValueError, "must not create verification work"):
            publication.operations(value, assignment())
        value["tasks"] = []
        with self.assertRaisesRegex(ValueError, "acceptance_check.test"):
            publication.operations(value, assignment())

    def test_binding_creates_only_missing_nodes_and_keeps_existing(self):
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
            nodes = data["joppa"]["test_nodes"]
            nodes.append({"address": "check:other", "title": "checks/checks.rs > other", "revision": 4, "status": "green"})
            data["joppa"]["test_schema"]["question"] = "Which test proves the criterion?"
            ops = publication.operations(value, data)
            self.assertEqual([op["command"]["op"] for op in ops], ["save_object", "finish_planning"])
            self.assertEqual(ops[0]["command"], {"op": "save_object", "kind": "check", "revision": 0,
                "parent": "criterion:a", "data": {"title": "checks/checks.rs > required_behavior", "owner": "owner"},
                "reason": "Bind an existing test after review of every criterion assertion.",
                "question_checked": "Which test proves the criterion?"})
            self.assertFalse(any(op["command"].get("id") or op["command"]["op"] not in ("save_object", "finish_planning")
                                 for op in ops))
            nodes.append({"address": "check:bound", "title": "checks/checks.rs > required_behavior",
                          "revision": 1, "status": "red"})
            self.assertEqual(len(publication.operations(value, data)), 1)
            retire = deepcopy(plan()["tasks"][0])
            retire.update(action="retire", target="work:old", revision=3)
            data["joppa"]["tasks"][0]["process"]["blocked"] = {"reason": "Failed", "position": 19}
            value["tasks"] = [retire]
            nodes.pop()
            self.assertEqual([op["command"]["op"] for op in publication.operations(value, data)],
                             ["retire_task", "save_object", "finish_planning"])

    def test_binding_honours_schema_limits_and_owner(self):
        data, value = assignment(), plan()
        value.update(disposition="verify_existing", tasks=[])
        joppa = data["joppa"]
        with self.assertRaisesRegex(ValueError, "at most 2 tests"):
            bind_missing("criterion:a", ["a.rs > one", "a.rs > two"], [{"title": "a.rs > zero"}],
                         {**joppa, "test_rules": {**joppa["test_rules"], "max_tests": 2}}, "owner")
        self.assertEqual(bind_missing("criterion:a", ["a.rs > one", "a.rs > one"], [{"title": "a.rs > zero"}],
                         {**joppa, "test_rules": {**joppa["test_rules"], "max_tests": 2}}, "owner")[0]["command"]["data"],
                         {"title": "a.rs > one", "owner": "owner"})
        for name, error in (("a.rs", "name rule"), ("noext > one", "extension"), ("a.rs > " + "x" * 30, "20-character")):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, error):
                bind_missing("criterion:a", [name], [], {**joppa, "test_schema": {"title_max_length": 20}}, "owner")
        required = {**joppa, "test_schema": {"required_fields": {"owner": "a test needs an owner"}}}
        with self.assertRaisesRegex(ValueError, "owner is required"):
            bind_missing("criterion:a", ["a.rs > one"], [], required, None)
        self.assertNotIn("question_checked", bind_missing("criterion:a", ["a.rs > one"], [], joppa, None)[0]["command"])

    def test_batch_limit_counts_test_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            data, value = assignment(), plan()
            data["repositories"][0]["path"] = directory
            lines = [f"assert!(case_{number}());" for number in range(100)]
            (Path(directory) / "checks.rs").write_text("\n".join(lines) + "\n")
            (Path(directory) / "implementation.rs").write_text("required_behavior\n")
            check = value["acceptance_checks"][0]
            value.update(disposition="verify_existing", tasks=[], acceptance_checks=[
                {**check, "test": f"checks.rs > case_{number}",
                 "evidence": f"service:checks.rs:{number + 1}; service:implementation.rs:1"} for number in range(100)])
            with self.assertRaisesRegex(ValueError, "at most 100 operations"):
                publication.operations(value, data)
            value["acceptance_checks"].pop()
            self.assertEqual(len(publication.operations(value, data)), 100)

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
            name = "checks/checks.rs > required_behavior"
            row = {"address": name, "status": "pass", "status_name": "pass", "commit": commit}
            api = NodeServer()
            snap = {"service": fingerprint(data["repositories"][0])}
            with self.assertRaisesRegex(ValueError, "passing result missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            api.add("check:bound", "criterion:a", name, result=row)
            data["joppa"]["test_nodes"] = [{"address": "check:bound", "title": name, "revision": 1, "status": "green"}]
            publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            api.add("check:another", "criterion:a", "checks/checks.rs > another", status="orange")
            data["joppa"]["test_nodes"].append({"address": "check:another", "title": "checks/checks.rs > another",
                                                "revision": 1, "status": "orange"})
            with self.assertRaisesRegex(ValueError, "existing criterion tests contain a failure or missing result"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            data["joppa"]["test_nodes"].pop()
            with self.assertRaisesRegex(ValueError, "snapshot is missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, {})
            row["status"] = "todo"
            with self.assertRaisesRegex(ValueError, "passing result missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            row["status"] = "pass"
            api.nodes["check:bound"]["parent"] = "criterion:b"
            api.nodes["check:bound"]["ancestor"] = "criterion:a"
            # A node under another criterion is not evidence for this source criterion.
            with self.assertRaisesRegex(ValueError, "passing result missing"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            api.nodes["check:bound"]["parent"] = "criterion:a"
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

    def test_acceptance_checks_cannot_disappear_from_published_tasks(self):
        data, value = assignment(), plan()
        check = {"repository": "service", "scenario": "Exercise the complete criterion", "expected": "Required result"}
        value["acceptance_checks"] = [check]
        with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
            publication.operations(value, data)
        value["tasks"][0]["checks"].append({key: val for key, val in check.items() if key != "repository"})
        saved = publication.operations(value, data)[0]["command"]
        self.assertIn("Exercise the complete criterion => Required result", context.task_contract(saved["data"]))
        value["acceptance_checks"][0]["repository"] = "client"
        data["repositories"].append({**deepcopy(data["repositories"][0]), "id": "client", "project": "project:q"})
        with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
            publication.operations(value, data)

    def test_unchanged_task_can_retain_its_acceptance_check(self):
        data, value = assignment(), plan()
        old = data["joppa"]["tasks"][0]
        old["document"]["data"]["body"] = publication.contract(deepcopy(value["tasks"][0]), value)
        value["tasks"][0]["checks"] = [{"scenario": "Another mechanism", "expected": "Another output"}]
        self.assertEqual(publication.operations(value, data)[0]["command"]["revision"], 0)
        for field in ("done", "retired"):
            with self.subTest(field=field):
                old["process"][field] = "Finished"
                with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
                    publication.operations(value, data)
                old["process"][field] = None
        value["tasks"][0].update(action="update", target="work:old", revision=3)
        with self.assertRaisesRegex(ValueError, "must be assigned to Task checks"):
            publication.operations(value, data)

    def test_published_check_preserves_both_scenario_and_command(self):
        data, value = assignment(), plan()
        for check in (value["acceptance_checks"][0], value["tasks"][0]["checks"][0]):
            check.update(command="bun test checks.test.ts", cwd="src")
        saved = context.task_contract(publication.operations(value, data)[0]["command"]["data"])
        self.assertIn("Reject invalid input [bun test checks.test.ts (cwd: src)] => No mutation", saved)
