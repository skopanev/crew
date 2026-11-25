"""Exercise the real prepare and emitter with a revision-checked tracker fixture."""
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import os
import re
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from textwrap import dedent
from unittest.mock import patch

from test_flow_batch import AtomicTracker
from test_configured_flow import Tracker, flow_stages, read
from provider_fixture import item


class AssignmentTransportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.api = Tracker()
        self.config = {"workspace": "example", "url": self.api.url, "runs_folder": str(self.root),
                       "selection": {"kind": "criterion"}, "references": ["sources"],
                       "publication": {"file": "operations.json"}}
        self.enterContext(patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.root / "run"),
                          "PLANNING_JOPPA_ITEM": "criterion:a"}))
        self.enterContext(patch.object(flow_stages, "settings", return_value=self.config))
        self.enterContext(patch.object(flow_stages, "client", return_value=self.api))

    def prepare(self, inline):
        output = StringIO()
        with patch.dict(os.environ, {"FLOW_ASSIGNMENT_INLINE": inline}), redirect_stdout(output):
            flow_stages.prepare()
        return output.getvalue()

    def test_file_flow_preserves_large_input_and_claim_without_emitting_the_blob(self):
        body = "x" * 120000 + "{{file:/unused}} </signal:var> Привет"
        self.api.nodes["source:s"]["document"]["data"]["body"] = body
        output = self.prepare("false")
        artifact = self.root / "run/artifacts/input.json"
        self.assertGreater(artifact.stat().st_size, 100000)
        assignment = read(artifact)
        self.assertEqual(assignment["references"]["sources"][0]["document"]["data"]["body"], body)
        self.assertEqual(assignment["claim_revision"], 4)
        self.assertEqual(len(self.api.batches), 1)
        self.assertEqual(read(self.root / "run/artifacts/contracts.json"), {})
        self.assertIn("<signal:PREPARED>", output)
        self.assertNotIn("<signal:var key=assignment>", output)

    def test_lander_workflow_claims_a_large_batch_without_exporting_its_assignment(self):
        workflow = Path(__file__).resolve().parents[2] / "lander/workflow.yaml"
        match = re.search(r"^  FLOW_ASSIGNMENT_INLINE: '([^']+)'$", workflow.read_text(), re.M)
        mode = match[1] if match else "true"
        self.api = AtomicTracker()
        body = "Large contract " * 2000
        self.api.nodes = {f"work:t{i}": item(f"work:t{i}", "criterion:a", {
            "title": f"Task {i}", "body": body, "repository": "service",
            "delivery": {"state": "pending", "head": f"{i:040x}", "branch": f"ticket-{i}"}}) for i in range(10)}
        self.config.update(selection={"kind": "work"}, references=[], batch={"size": 10})
        with patch.object(flow_stages, "client", return_value=self.api), \
                patch.dict(os.environ, {"PLANNING_JOPPA_ITEM": "work:t0"}):
            output = self.prepare(mode)
        artifact = self.root / "run/artifacts/input.json"
        assignment = read(artifact)
        self.assertGreater(artifact.stat().st_size, 100000)
        self.assertEqual(len(assignment["items"]), 10)
        self.assertEqual(len(assignment["claim_revisions"]), 10)
        self.assertTrue(all(node["document"]["data"]["body"] == body for node in assignment["items"]))
        self.assertEqual(len(self.api.batches), 1)
        self.assertIn("<signal:PREPARED>", output)
        self.assertNotIn("<signal:var key=assignment>", output)

    def test_lander_failed_signal_starts_a_line_and_routes_to_failure(self):
        workflow = (Path(__file__).resolve().parents[2] / "lander/workflow.yaml").read_text()
        failed = workflow.split("\n  failed:\n", 1)[1].split("\n  clean_success:", 1)[0]
        shell, routes = failed.split("    on_signal:\n", 1)
        shell = dedent(shell.split("    shell: |\n", 1)[1])
        target = self.root / "run/artifacts"
        target.mkdir(parents=True)
        (target / "result.json").write_text('{}')
        binary = self.root / "bin"
        binary.mkdir()
        node = binary / "node"
        node.write_text('#!/bin/sh\nprintf "cleanup\\n"\n')
        node.chmod(0o755)
        result = subprocess.run(["bash", "-c", "printf prefix\n" + shell], check=True,
            env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                 "MEDULLA_WORKFLOW_DIR": str(self.root)}, capture_output=True, text=True)
        self.assertRegex(result.stdout, r"^prefix\n<signal:BLOCKED>[^\n]+</signal:BLOCKED>\ncleanup\n$")
        self.assertRegex(routes, r"(?m)^      BLOCKED: __exit_fail__$")

    def test_default_inline_flow_keeps_the_existing_emitter(self):
        with patch.dict(os.environ):
            os.environ.pop("FLOW_ASSIGNMENT_INLINE", None)
            output = StringIO()
            with redirect_stdout(output):
                flow_stages.prepare()
            self.assertIn("<signal:var key=assignment>", output.getvalue())

    def test_inline_flow_keeps_the_existing_size_limit(self):
        self.api.nodes["source:s"]["document"]["data"]["body"] = "x" * 120000
        with self.assertRaisesRegex(ValueError, "assignment: context too large"):
            self.prepare("true")

    def test_invalid_mode_fails_before_loading_context_or_claiming(self):
        with patch.object(flow_stages.flow_context, "load") as load:
            with self.assertRaisesRegex(ValueError, "FLOW_ASSIGNMENT_INLINE must be true or false"):
                self.prepare("no")
            load.assert_not_called()
        self.assertEqual(self.api.batches, [])

    def test_cli_invalid_mode_does_not_enter_failure_cleanup_or_initialize_the_api(self):
        with patch.dict(os.environ, {"FLOW_ASSIGNMENT_INLINE": "invalid"}), \
                patch.object(sys, "argv", ["flow_stages.py", "prepare"]), \
                patch.object(flow_stages, "settings") as settings, \
                patch.object(flow_stages, "client") as client, redirect_stderr(StringIO()):
            self.assertEqual(flow_stages.main(), 1)
            settings.assert_not_called()
            client.assert_not_called()
        self.assertEqual(self.api.batches, [])
