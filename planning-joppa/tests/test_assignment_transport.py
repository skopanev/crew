"""Exercise the real prepare and emitter with a revision-checked tracker fixture."""
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_configured_flow import Tracker, flow_stages, read


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
