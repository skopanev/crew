"""Check the configured deadline at the actual Medulla launch boundary."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "planning-joppa"), str(ROOT / "planning")]
import flow_launch


class FlowDeadlineTests(unittest.TestCase):
    def test_deadline_keeps_the_source_anchor_and_helper_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            source = ROOT / "lander/workflow.yaml"
            original = source.read_bytes()
            config = {"workspace": "example", "url": "https://example.invalid/mcp", "mcp_command": ["fixture"],
                "runs_folder": folder, "workflow": str(source), "workflow_timeout_seconds": 7200,
                "selection": {"kind": "work"}, "publication": {"file": "operations.json"}}
            def execute(command, env, working, current):
                rendered = Path(command[2]).read_text()
                self.assertIn("timeout: &workflow_timeout 7200\n", rendered)
                self.assertIn("timeout: *workflow_timeout", rendered)
                variables = dict(command[index + 1].split("=", 1) for index, arg in enumerate(command) if arg == "--var")
                self.assertEqual(variables["CREW_FLOW_WORKFLOW_DIR"], str(source.parent))
                self.assertEqual(source.read_bytes(), original)
                return 0
            with patch("flow_runtime.execute", side_effect=execute), patch("shutil.which", return_value="medulla"):
                self.assertEqual(flow_launch.launch(Path(folder) / "config.json", json.dumps(config), "work:a", False), 0)
            for invalid in [True, 0, -1, "7200"]:
                with self.assertRaisesRegex(ValueError, "workflow_timeout_seconds"):
                    flow_launch.configuration("unused", json.dumps({**config, "workflow_timeout_seconds": invalid}))


if __name__ == "__main__":
    unittest.main()
