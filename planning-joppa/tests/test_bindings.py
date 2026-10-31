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
            data["joppa"]["test_status"]["tests"].append({"address": "checks/checks.rs > another", "status": "not_run"})
            with self.assertRaisesRegex(ValueError, "existing criterion tests contain a failure or missing result"):
                publication.verify_bindings(api, {"workspace": "example"}, value, data, snap)
            data["joppa"]["test_status"]["tests"].pop()
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
