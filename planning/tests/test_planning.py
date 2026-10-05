import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLANNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLANNING))
from common import validate_input, fingerprint
from validation import plan
from joppa_fixture import JoppaFixture


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crew-planning-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.joppa = JoppaFixture(self.root)
        self.addCleanup(self.joppa.close)
        repo = self.root / "repo"
        (repo / "src").mkdir(parents=True)
        (repo / "src/main.py").write_text("value = 1\n")
        for args in (["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]):
            subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
        self.assignment = {"workspace": "test", "requirement": {"id": "req-1", "revision": 1, "text": "Expected outcome"},
                           "domain": {"id": "domain-1", "text": "Reliable delivery"},
                           "capability": {"id": "cap-1", "text": "Bounded work scheduling"},
                           "ac": {"id": "ac-1", "text": "The predicate returns true"}, "decisions": [],
                           "repositories": [{"id": "test", "path": str(repo), "cbm_project": "test-project",
                                             "modules": [{"name": "src", "path": "src"}]}]}
        self.input = self.root / "input.json"
        self.input.write_text(json.dumps(self.assignment))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("codex", "claude", "agy", "opencode", "fake-equill", "fake-cbm"):
            script = self.bin / name
            script.write_text((PLANNING / "tests/fake_tools.py").read_text())
            script.chmod(0o755)
        executable = os.environ.get("MEDULLA_BIN", "medulla")
        if not shutil.which(executable):
            self.skipTest("set MEDULLA_BIN to the installed Medulla executable")
        self.env = {**os.environ, **self.joppa.env, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "MEDULLA_BIN": executable, "PLANNING_TEST_ROOT": str(self.root),
                    "EQUILL_BIN": str(self.bin / "fake-equill"), "CREW_SKIP_ROLE_CHECK": "1", "CBM_BIN": str(self.bin / "fake-cbm"),
                    "MEDULLA_STREAM": "0", "MEDULLA_RETRY_DELAY_S": "0",
                    # Fake providers need no host AGY trust; native adapters are
                    # still exercised, but no real account/agent is invoked.
                    "MEDULLA_DOCKER": "1"}

    def execute(self, case="ready", dry=False):
        command = [sys.executable, str(PLANNING / "launch.py"), "--input", str(self.input),
                   "--runs-folder", str(self.root / "runs"), "--cbm-store", str(self.root),
                   "--cbm-root", str(self.root), "--equill-store", str(self.root)]
        if dry:
            command += ["--dry-run"]
        proc = subprocess.run(command, cwd=self.root, env={**self.env, "PLANNING_TEST_CASE": case},
                              capture_output=True, text=True, timeout=30)
        if dry:
            return proc, None
        files = list((self.root / "runs").rglob("artifacts/result.json"))
        self.assertEqual(len(files), 1, proc.stdout + proc.stderr)
        return proc, json.loads(files[0].read_text())

    def test_real_engine_runs_both_pools_in_parallel_and_delivers_plan(self):
        proc, result = self.execute()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(result["status"], "ready")
        self.assertFalse(result["joppa_updated"])
        self.assertTrue(result["joppa_currentness_verified"])
        self.assertIn("completed_at", result)
        self.assertEqual(result["scope"], "local_plan")
        for level in ("domain", "capability"):
            self.assertEqual(result[level]["id"], self.assignment[level]["id"])
            self.assertEqual(result[level]["text"].strip(), self.assignment[level]["text"])
        self.assertEqual(len(result["reviews"]), 3)
        events = [json.loads(line) for line in (self.root / "events.jsonl").read_text().splitlines()]
        used = {e["slug"]: (e["binary"], e["model"]) for e in events if e["kind"] == "start"}
        self.assertEqual(used["design"], ("claude", "claude-opus-5-5"))
        self.assertEqual(used["necessity"], ("codex", "gpt-6.1-sol"))
        self.assertEqual(used["simplicity"], ("agy", "Gemini 3.1 Pro (High)"))
        self.assertEqual(used["correctness"], ("opencode", "zai-coding-plan/glm-5.3"))
        self.assertEqual(len({v["reviewer"]["harness"] for v in result["reviews"].values()}), 3)
        for group in (("code", "knowledge", "external"), ("necessity", "simplicity", "correctness")):
            starts = [e["time"] for e in events if e["kind"] == "start" and e["slug"] in group]
            ends = [e["time"] for e in events if e["kind"] == "end" and e["slug"] in group]
            self.assertEqual(len(starts), 3)
            self.assertLess(max(starts), min(ends), "pool ran sequentially")

    def test_rejected_plan_returns_to_design_once_with_the_findings(self):
        proc, result = self.execute("rejected_once")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(result["status"], "ready")
        self.assertTrue((self.root / "design-saw-critique").exists(), "design did not receive the critic findings")
        events = [json.loads(line) for line in (self.root / "events.jsonl").read_text().splitlines()]
        starts = [e["slug"] for e in events if e["kind"] == "start"]
        self.assertEqual(starts.count("design"), 2)
        self.assertEqual(starts.count("simplicity"), 2)

    def test_failures_never_admit_work(self):
        for case in ("missing_contract", "no_cbm", "outside_module", "rejected", "malformed", "stale", "changed_contract",
                     "signal_breakout", "stuck_pagination", "stale_index", "index_generation_mismatch", "no_coverage", "uncovered_citation", "joppa_changed", "changed_review_plan"):
            with self.subTest(case=case):
                proc, result = self.execute(case)
                self.assertNotEqual(proc.returncode, 0, case)
                self.assertEqual(result["status"], "blocked", case)
                shutil.rmtree(self.root / "runs")
                (self.root / "repo/src/main.py").write_text("value = 1\n")

    def test_pool_failures_preserve_branch_and_parse_error(self):
        for case, branch in (("malformed_research", "code"), ("malformed_critic", "correctness")):
            with self.subTest(case=case):
                proc, result = self.execute(case)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(result["status"], "blocked")
                self.assertIn(branch, result["reason"])
                self.assertIn("Expecting value", result["reason"])
                self.assertEqual(result["errors"][0]["branch"], branch)
                shutil.rmtree(self.root / "runs")

    def test_nested_signals_remain_context_and_project_pagination_completes(self):
        for case in ("nested_signal", "paginated", "wrong_digest"):
            with self.subTest(case=case):
                proc, result = self.execute(case)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertEqual(result["status"], "ready")
                shutil.rmtree(self.root / "runs")

    def test_fingerprint_streams_untracked_bytes_and_detects_content_changes(self):
        path = self.root / "repo/src/artifact.bin"
        path.write_bytes(b"a" * (3 * 1024 * 1024))
        repo = self.assignment["repositories"][0]
        with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
            before = fingerprint(repo)
            self.assertEqual(before, fingerprint(repo))
            with path.open("r+b") as file:
                file.seek(2 * 1024 * 1024)
                file.write(b"b")
            self.assertNotEqual(before, fingerprint(repo))

    def test_existing_behavior_routes_to_verification_without_tasks(self):
        proc, result = self.execute("existing")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(result["status"], "verify_existing")
        self.assertEqual(result["plan"]["tasks"], [])

    def test_dry_run_has_no_provider_calls_or_run_artifacts(self):
        proc, _ = self.execute(dry=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertFalse((self.root / "events.jsonl").exists())
        self.assertFalse(list((self.root / "runs").rglob("result.json")))
        self.assertEqual(self.joppa.calls, [])


class ValidationTests(unittest.TestCase):
    def test_requires_domain_and_capability_meaning(self):
        original = json.loads((PLANNING / "input.example.json").read_text())
        for level in ("domain", "capability"):
            for invalid in (None, {}, {"id": "present", "text": " "}):
                with self.subTest(level=level, invalid=invalid):
                    data = copy.deepcopy(original)
                    data[level] = invalid
                    with self.assertRaisesRegex(ValueError, level):
                        validate_input(data)

    def test_rejects_path_traversal_and_duplicate_repositories(self):
        data = json.loads((PLANNING / "input.example.json").read_text())
        data["repositories"][0]["modules"][0]["path"] = "../outside"
        with self.assertRaisesRegex(ValueError, "relative path"):
            validate_input(data)
        data["repositories"][0]["modules"][0]["path"] = "."
        data["repositories"].append(copy.deepcopy(data["repositories"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate repository"):
            validate_input(data)


if __name__ == "__main__":
    unittest.main()
