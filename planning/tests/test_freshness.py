from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import shutil
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import digest
from freshness import admit, snapshot, StalePlan
from joppa_fixture import JoppaFixture


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.peer = JoppaFixture()
        self.addCleanup(self.peer.close)
        self.env = patch.dict(os.environ, self.peer.env)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.now = datetime(2026, 9, 28, 12, tzinfo=timezone.utc)
        plan = {"tasks": [{"id": "one"}]}
        self.result = {"status": "ready", "plan": plan, "plan_digest": digest(plan),
                       "completed_at": self.now.isoformat(), "joppa_currentness_verified": True,
                       "joppa_snapshot": snapshot("test", "req-1", "ac-1")}

    def check(self, result=None, now=None):
        return admit(result or self.result, clock=lambda: now or self.now)

    def test_exact_24_hour_boundary_and_checks_never_renew_completion(self):
        before = deepcopy(self.result)
        self.assertEqual(self.check(now=self.now + timedelta(hours=24, microseconds=-1))["status"], "allowed")
        for age in (timedelta(hours=24), timedelta(hours=25)):
            with self.assertRaisesRegex(StalePlan, "24 hours"):
                self.check(now=self.now + age)
        self.assertEqual(before, self.result)
        with self.assertRaisesRegex(ValueError, "future"):
            self.check(now=self.now - timedelta(seconds=1))

    def test_expiry_while_reading_also_refuses(self):
        times = iter((self.now + timedelta(hours=23), self.now + timedelta(hours=24)))
        with self.assertRaises(StalePlan):
            admit(self.result, clock=lambda: next(times))

    def test_each_level_and_relationship_change_expires_plan(self):
        original_index, original_detail = deepcopy(self.peer.index), deepcopy(self.peer.detail)
        mutations = (
            lambda: self.peer.index["index"]["domains"]["domain-1"].update(description="changed"),
            lambda: self.peer.index["index"]["capabilities"]["cap-1"].update(title="changed"),
            lambda: self.peer.detail["requirement"]["revisions"][0].update(body="changed"),
            lambda: self.peer.detail["requirement"]["revisions"][0]["acs"][0].update(text="changed"),
            lambda: self.peer.detail["requirement"]["revisions"][0]["acs"][0].update(depends_on=["another"]),
        )
        for mutation in mutations:
            self.peer.index, self.peer.detail = deepcopy(original_index), deepcopy(original_detail)
            mutation()
            with self.assertRaisesRegex(StalePlan, "changed"):
                self.check()

    def test_unrelated_activity_and_reads_do_not_expire_plan(self):
        self.peer.index["position"] = self.peer.detail["position"] = 100
        self.peer.detail["requirement"]["revisions"][0]["tasks"] = {"other": {"status": "done"}}
        self.peer.index["index"]["domains"]["unrelated"] = {"title": "another domain"}
        self.assertEqual(self.check()["status"], "allowed")
        self.assertEqual(self.check()["status"], "allowed")

    def test_unreadable_incoherent_missing_and_old_receipts_never_allow(self):
        self.peer.status = 401
        with self.assertRaisesRegex(ValueError, "401"):
            self.check()
        self.peer.status = 200
        self.peer.detail["position"] = 2
        with self.assertRaisesRegex(ValueError, "changed during read"):
            self.check()
        self.peer.detail["position"] = 1
        self.peer.detail["requirement"]["revisions"][0]["acs"] = []
        with self.assertRaises(ValueError):
            self.check()
        old = deepcopy(self.result)
        del old["joppa_snapshot"]
        with self.assertRaises(StalePlan):
            self.check(old)

    def test_cli_distinguishes_stale_and_read_error_without_mutating_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "result.json"
            result = deepcopy(self.result)
            result["completed_at"] = datetime.now(timezone.utc).isoformat()
            path.write_text(json.dumps(result))
            command = [sys.executable, str(Path(__file__).resolve().parents[1] / "admit.py"), "--result", str(path)]
            before = path.read_bytes()
            proc = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.peer.status = 503
            proc = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(json.loads(proc.stdout)["status"], "error")
            self.assertEqual(path.read_bytes(), before)
            result["completed_at"] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
            path.write_text(json.dumps(result))
            proc = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 3)
            self.assertEqual(json.loads(proc.stdout)["status"], "stale")

    def test_lane_checks_before_setup_and_again_before_medulla(self):
        if not shutil.which("node") or not shutil.which("jq"):
            self.skipTest("lane integration requires node and jq")
        crew = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tooling = root / "tooling"
            (tooling / "lane").mkdir(parents=True)
            (tooling / "lane-launcher").mkdir()
            shutil.copy(crew / "lane/run.sh", tooling / "lane/run.sh")
            shutil.copy(crew / "lane-launcher/scope.mjs", tooling / "lane-launcher/scope.mjs")
            (tooling / "planning").symlink_to(crew / "planning", target_is_directory=True)
            (tooling / "lane-launcher/ntk.mjs").write_text('export async function getTicket() { return {module:"src"}; }\n')
            repo = root / "repo"
            (repo / ".git").mkdir(parents=True)
            cbm = root / "cbm"
            cbm.mkdir()
            bridge = root / "bridge"
            (bridge / "equill").mkdir(parents=True)
            (bridge / "equill/bridge.pid").write_text(str(os.getpid()))
            (bridge / "equill/bridge.identity").write_text("lane:" + str(os.getpid()))
            binary = root / "bin"
            binary.mkdir()
            result = deepcopy(self.result)
            result["plan"] = {"tasks": [{"id": "one", "repository": "test", "module": "src"}]}
            result["plan_digest"] = digest(result["plan"])
            receipt = root / "result.json"
            source = {"repositories": [{"id": "test", "path": str(repo)}]}
            (root / "input.json").write_text(json.dumps(source))
            result["input_digest"] = digest(source)
            # Test-only container probe can mutate the receipt after the first
            # admission, proving that the second check guards actual execution.
            (binary / "docker").write_text("#!/usr/bin/env python3\nimport os,json,pathlib,datetime\np=pathlib.Path(os.environ['TEST_RECEIPT'])\nif os.environ.get('EXPIRE_DURING_SETUP'):\n d=json.loads(p.read_text()); d['completed_at']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=1)).isoformat(); p.write_text(json.dumps(d))\n")
            (binary / "medulla").write_text("#!/usr/bin/env python3\nimport os,pathlib\nassert not os.environ.get('JOPPA_TOKEN') and not os.environ.get('JOPPA_TOKEN_FILE')\npathlib.Path(os.environ['LAUNCH_MARKER']).write_text('launched')\n")
            for name in ("docker", "medulla"):
                (binary / name).chmod(0o755)
            marker = root / "launched"
            env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                   "LANE_RUNS_FOLDER": str(root / "runs"), "MEDULLA_BRIDGE": str(bridge),
                   "TEST_RECEIPT": str(receipt), "LAUNCH_MARKER": str(marker)}
            command = ["bash", str(tooling / "lane/run.sh"), "--ticket-id", "test-ticket", "--project", "test",
                       "--dispatcher-id", "fixture",
                       "--mount-rw", str(repo), "--cbm-store", str(cbm), "--gate-command", "true",
                       "--planning-result", str(receipt), "--planning-task", "one"]
            for scenario, code in (("expired", 3), ("read_error", 2), ("expired_during_setup", 3), ("fresh", 0)):
                with self.subTest(scenario=scenario):
                    result["completed_at"] = (datetime.now(timezone.utc) - timedelta(days=1 if scenario == "expired" else 0)).isoformat()
                    receipt.write_text(json.dumps(result))
                    self.peer.status = 503 if scenario == "read_error" else 200
                    proc = subprocess.run(command, env={**env, "EXPIRE_DURING_SETUP": "1" if scenario == "expired_during_setup" else ""},
                                          capture_output=True, text=True, timeout=20)
                    self.assertEqual(proc.returncode, code, proc.stdout + proc.stderr)
                    self.assertEqual(marker.exists(), scenario == "fresh", proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
