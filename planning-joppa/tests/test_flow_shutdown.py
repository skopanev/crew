"""Configured flow cleanup uses the original settings and the confirmed claim."""
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "planning-joppa"), str(ROOT / "planning"), str(Path(__file__).parent)]
from common import digest, read, write
from test_configured_flow import Tracker
import flow_stages
import flow_runtime


class FlowShutdownTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.folder = self.root / "run"
        self.target = self.folder / "artifacts"
        self.api = Tracker()
        self.api.stdio = None
        self.config = {"workspace": "example", "url": self.api.url, "runs_folder": str(self.root),
            "workflow": str(ROOT / "writer/workflow.yaml"), "mcp_command": ["connector"],
            "selection": {"kind": "criterion"}, "children": {"kind": "work"}, "references": ["sources"],
            "publication": {"file": "operations.json", "allowed_operations": ["save_object", "note"],
                            "create_kinds": ["check"], "update_kinds": ["work"]}}
        self.live = self.root / "live.json"
        self.snapshot = self.root / "snapshot.json"
        write(self.live, self.config)
        write(self.snapshot, self.config)
        self.enterContext(patch.dict(os.environ, {"MEDULLA_RUN_DIR": str(self.folder),
            "PLANNING_JOPPA_CONFIG": str(self.live), "PLANNING_JOPPA_CONFIG_SNAPSHOT": str(self.snapshot),
            "PLANNING_JOPPA_CONFIG_DIGEST": digest(self.config), "PLANNING_JOPPA_ITEM": "criterion:a"}))
        self.enterContext(patch.object(flow_stages, "client", return_value=self.api))
        self.enterContext(patch.object(flow_runtime, "Joppa", return_value=self.api))
        flow_stages.prepare()

    def assert_released(self):
        self.assertEqual(read(self.target / "release.json")["status"], "confirmed")
        self.assertTrue(read(self.target / "result.json")["claim_released"])
        self.assertNotIn("assignee", self.api.nodes["criterion:a"]["document"]["data"])
        self.assertEqual(self.api.nodes["work:t"]["document"]["data"]["stage"], "waiting")
        self.assertEqual(self.api.batches[-1]["workspace"], "example")
        self.assertEqual(len(self.api.batches), 2)

    def test_config_drift_stops_verify_but_releases_with_original_settings(self):
        write(self.live, {**self.config, "workspace": "different"})
        with patch.object(sys, "argv", ["flow_stages.py", "verify"]):
            self.assertEqual(flow_stages.main(), 1)
        self.assert_released()
        self.assertIn("flow config changed", read(self.target / "result.json")["reason"])

    def test_changed_snapshot_is_refused_before_release(self):
        write(self.snapshot, {**self.config, "workspace": "different"})
        with self.assertRaisesRegex(ValueError, "release config digest differs"):
            flow_stages.failure("Interrupted")
        self.assertFalse((self.target / "release.json").exists())
        self.assertEqual(len(self.api.batches), 1)

    def test_ctrl_c_waits_for_medulla_exit_then_releases_once(self):
        script = """import os, signal, sys, time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
print(sys.argv[1], flush=True)
os.kill(os.getppid(), signal.SIGINT)
time.sleep(60)
"""
        previous = signal.getsignal(signal.SIGINT)
        code = flow_runtime.execute([sys.executable, "-c", script, str(self.folder)],
                                    dict(os.environ), self.root, self.config)
        self.assertEqual(code, 130)
        self.assertEqual(signal.getsignal(signal.SIGINT), previous)
        self.assert_released()

    def test_uncertain_publication_or_replaced_holder_sends_no_release(self):
        for mode in ("uncertain", "replaced"):
            with self.subTest(mode=mode):
                if mode == "uncertain":
                    write(self.target / "publication.json", {"status": "uncertain"})
                else:
                    (self.target / "publication.json").unlink()
                    self.api.nodes["criterion:a"]["document"]["data"]["assignee"] = "another-run"
                flow_runtime.release(self.config, self.folder, "Interrupted", True)
                self.assertFalse((self.target / "release.json").exists())
                self.assertTrue(read(self.target / "result.json")["needs_recovery"])
                self.assertEqual(len(self.api.batches), 1)

    def test_unconfirmed_shutdown_keeps_the_claim(self):
        flow_runtime.release(self.config, self.folder, "Interrupted", False)
        self.assertFalse((self.target / "release.json").exists())
        self.assertTrue(read(self.target / "result.json")["needs_recovery"])
        self.assertEqual(len(self.api.batches), 1)

    def test_forced_medulla_shutdown_does_not_release(self):
        script = """import os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
print(sys.argv[1], flush=True)
os.kill(os.getppid(), signal.SIGINT)
time.sleep(60)
"""
        with patch.object(flow_runtime, "STOP_SECONDS", 0.1):
            self.assertEqual(flow_runtime.execute([sys.executable, "-c", script, str(self.folder)],
                             dict(os.environ), self.root, self.config), 130)
        self.assertFalse((self.target / "release.json").exists())
        self.assertTrue(read(self.target / "result.json")["needs_recovery"])
        self.assertEqual(len(self.api.batches), 1)


if __name__ == "__main__":
    unittest.main()
