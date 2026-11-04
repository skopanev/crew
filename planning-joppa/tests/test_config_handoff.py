"""The dispatcher hands the pass a digest of the validated config bytes. No network or live mutations."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ConfigHandoffTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.config = self.folder / "config.json"
        self.config.write_text(json.dumps({"workspace": "product", "url": "https://joppa.example/mcp",
            "token_file": "token", "runs_folder": "runs", "cbm_store": "cbm", "cbm_root": "src",
            "equill_store": "equill", "repositories": [{"id": "app", "project": "project:app",
            "path": str(self.folder / "src" / "app"), "cbm_project": "app", "modules": [{"name": "core", "path": "src"}]}]}))
        self.started = self.folder / "medulla-started"
        medulla = self.folder / "medulla"
        medulla.write_text(f"#!/bin/sh\ntouch '{self.started}'\n")
        medulla.chmod(0o755)
        self.medulla = medulla

    def launch(self, handoff, *extra):
        env = {**os.environ, "MEDULLA_BIN": str(self.medulla), "PLANNING_JOPPA_HANDOFF_DIGEST": handoff}
        return subprocess.run([sys.executable, str(ROOT / "planning-joppa/launch.py"), "--config", str(self.config),
            "--req-id", "requirement:r", *extra], env=env, capture_output=True, text=True)

    def test_changed_handoff_is_refused_before_medulla(self):
        selected = hashlib.sha256(self.config.read_bytes()).hexdigest()
        self.config.write_text(self.config.read_text().replace('"product"', '"other"'))
        result = self.launch(selected)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn("planner config changed after the dispatcher selected this pass", result.stderr)
        self.assertNotIn(selected, result.stderr + result.stdout)
        self.assertFalse(self.started.exists())

    def test_matching_handoff_continues(self):
        result = self.launch(hashlib.sha256(self.config.read_bytes()).hexdigest(), "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Dry run: no MCP calls", result.stdout)
        self.assertFalse(self.started.exists())


if __name__ == "__main__":
    unittest.main()
