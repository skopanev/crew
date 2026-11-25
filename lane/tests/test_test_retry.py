"""Strict retry proofs from real processes and immutable Git fixtures."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import test_report
import test_retry

SETTINGS = {"path": "junit/report.xml", "format": "junit", "identity": "{file} > {name}"}
RUNNER = '''import os, pathlib, subprocess, sys, time
from xml.sax.saxutils import quoteattr
file = sys.argv[-1]
mode = os.environ.get("RETRY_MODE", "pass")
if mode == "sleep": time.sleep(120)
counter = pathlib.Path(os.environ["RETRY_COUNTER"])
n = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(n))
if mode == "second_red" and n == 2: mode = "red"
if mode == "head": subprocess.run(["git", "commit", "--allow-empty", "-qm", "changed"], check=True)
out = pathlib.Path(os.environ["CREW_TEST_REPORT_DIR"]) / "junit/report.xml"
out.parent.mkdir(parents=True)
cases = '<testcase name="bad" file=' + quoteattr(file) + '>'
cases += '<failure message="persistent"/>' if mode == "red" else '<skipped/>' if mode == "skip" else ''
cases += '</testcase>'
if mode != "omit": cases += '<testcase name="good" file=' + quoteattr(file) + '/>'
if mode in ("old_skip", "new_skip"):
 cases += '<testcase name=' + quoteattr(mode) + ' file=' + quoteattr(file) + '><skipped/></testcase>'
if mode != "missing": out.write_text('<testsuite>' + cases + '</testsuite>')
print("sample", file, mode)
sys.exit(1 if mode == "red" else 0)
'''


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.previous = Path.cwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, self.previous)
        self.environment = mock.patch.dict(os.environ, {
            "ticket_id": "task", "MEDULLA_RUN_DIR": str(self.root / "run"),
            "project_dir": str(self.repo), "module_name": ".", "test_report": json.dumps(SETTINGS),
            "NOT_REPRODUCED": json.dumps({"command": [sys.executable, "runner.py"], "attempts": 1}),
            "RETRY_COUNTER": str(self.root / "counter"), "RETRY_MODE": "pass",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        for args in [("init", "-q"), ("config", "user.name", "Fixture"),
                     ("config", "user.email", "fixture@example.invalid")]:
            self.git(*args)
        (self.repo / "runner.py").write_text(RUNNER)
        (self.repo / "tests").mkdir()
        (self.repo / "tests/a.py").write_text("tracked\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.folder = self.root / "run/artifacts/gates/full"
        self.folder.mkdir(parents=True)
        self.path = self.folder / "receipt.json"
        state = test_report.begin(self.folder)
        started = time.time()
        log = self.folder / "1.log"
        with log.open("wb") as output:
            result = subprocess.run([sys.executable, "runner.py", "tests/a.py"],
                                    env={**os.environ, "RETRY_MODE": "red"}, stdout=output, stderr=subprocess.STDOUT)
        self.receipt = {"schema": 1, "task": "task", "run": str(self.root / "run"),
                        "repository": str(self.repo), "module": ".", "cwd": str(self.repo),
                        "base": self.git("rev-parse", "HEAD"), "tree": self.git("rev-parse", "HEAD^{tree}"),
                        "commands": ["initial full"], "timeout_seconds": 10, "passed": False, "unchanged": True,
                        "checks": [{"command": "initial full", "exit_code": result.returncode,
                                    "timed_out": False, "stdout_matches": True, "started_at": started,
                                    "log": str(log), "sha256": test_retry.hashed(log)}],
                        "test_report": test_report.finish(state, started)}
        (self.root / "counter").unlink()

    def git(self, *args):
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.PIPE).strip()

    def proof(self):
        before = copy.deepcopy(self.receipt)
        proof = test_retry.run(self.path, self.receipt)
        self.assertEqual(self.receipt, before)
        self.assertIsNotNone(proof)
        final = {**self.receipt, "passed": True, "not_reproduced": proof}
        self.assertTrue(test_retry.verify(self.path, final))
        return final

    def test_real_subprocess_pass_preserves_initial_red_and_verifies(self):
        final = self.proof()
        self.assertEqual(final["not_reproduced"]["filenames"], ["tests/a.py"])
        self.assertEqual(json.loads((self.folder / "initial.json").read_text()), self.receipt)
        self.assertEqual(len(final["not_reproduced"]["reruns"]), 1)

    def test_two_samples_must_both_pass(self):
        os.environ["NOT_REPRODUCED"] = json.dumps({"command": [sys.executable, "runner.py"], "attempts": 2})
        self.assertEqual(len(self.proof()["not_reproduced"]["reruns"]), 2)

    def test_two_failed_files_need_two_complete_samples_each(self):
        (self.repo / "tests/b.py").write_text("tracked\n")
        self.git("add", "tests/b.py")
        self.git("commit", "-qm", "second file")
        self.receipt.update(base=self.git("rev-parse", "HEAD"), tree=self.git("rev-parse", "HEAD^{tree}"))
        entry = self.receipt["test_report"]
        file = self.folder / "test-report" / entry["path"]
        data = file.read_text()
        file.write_text(data.replace("</testsuite>", data.split("<testsuite>")[1]
                                    .replace('file="tests/a.py"', 'file="tests/b.py"')))
        entry["sha256"] = test_retry.hashed(file)
        entry["results"] = test_report.parse(file.read_bytes(), SETTINGS["identity"])
        os.environ["NOT_REPRODUCED"] = json.dumps({"command": [sys.executable, "runner.py"], "attempts": 2})
        final = self.proof()
        self.assertEqual(final["not_reproduced"]["filenames"], ["tests/a.py", "tests/b.py"])
        self.assertEqual(len(final["not_reproduced"]["reruns"]), 4)
        final["not_reproduced"]["reruns"].pop()
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)

    def test_persistent_or_second_red_never_becomes_green(self):
        for mode in ("red", "second_red"):
            with self.subTest(mode=mode):
                if (self.folder / "initial.json").exists():
                    (self.folder / "initial.json").unlink()
                (self.root / "counter").unlink(missing_ok=True)
                os.environ["RETRY_MODE"] = mode
                os.environ["NOT_REPRODUCED"] = json.dumps({"command": [sys.executable, "runner.py"], "attempts": 2})
                self.assertIsNone(test_retry.run(self.path, self.receipt))

    def test_missing_skipped_and_omitted_previously_passing_identity_refuse(self):
        for mode in ("missing", "skip", "omit"):
            with self.subTest(mode=mode):
                (self.folder / "initial.json").unlink(missing_ok=True)
                os.environ["RETRY_MODE"] = mode
                self.assertIsNone(test_retry.run(self.path, self.receipt))

    def test_original_skips_can_remain_while_every_executed_case_passes(self):
        entry = self.receipt["test_report"]
        file = self.folder / "test-report" / entry["path"]
        file.write_text(file.read_text().replace("</testsuite>",
            '<testcase name="old_skip" file="tests/a.py"><skipped/></testcase></testsuite>'))
        entry["sha256"] = test_retry.hashed(file)
        entry["results"] = test_report.parse(file.read_bytes(), SETTINGS["identity"])
        os.environ["RETRY_MODE"] = "old_skip"
        self.proof()

    def test_new_skipped_identity_refuses_a_green_process(self):
        os.environ["RETRY_MODE"] = "new_skip"
        self.assertIsNone(test_retry.run(self.path, self.receipt))

    def test_mutated_log_is_refused(self):
        final = self.proof()
        Path(final["not_reproduced"]["reruns"][0]["log"]).write_text("changed")
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)

    def test_mutated_head_is_refused_even_with_the_same_tree(self):
        final = self.proof()
        self.git("commit", "--allow-empty", "-qm", "new head")
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)

    def test_runner_that_changes_head_cannot_produce_a_proof(self):
        os.environ["RETRY_MODE"] = "head"
        self.assertIsNone(test_retry.run(self.path, self.receipt))

    def test_changed_xml_or_embedded_results_are_refused(self):
        final = self.proof()
        final["not_reproduced"]["reruns"][0]["test_report"]["results"][0]["outcome"] = "skip"
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)

    def test_malformed_report_objects_raise_value_error(self):
        final = self.proof()
        for invalid in ([], None, "report"):
            with self.subTest(invalid=invalid):
                changed = copy.deepcopy(final)
                changed["not_reproduced"]["reruns"][0]["test_report"] = invalid
                with self.assertRaises(ValueError):
                    test_retry.verify(self.path, changed)

    def test_missing_proof_is_false_and_changed_policy_refuses(self):
        self.assertFalse(test_retry.verify(self.path, self.receipt))
        final = self.proof()
        os.environ["NOT_REPRODUCED"] = json.dumps({"command": ["different"], "attempts": 1})
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)

    def test_duplicate_sample_and_escaping_log_are_refused(self):
        os.environ["NOT_REPRODUCED"] = json.dumps({"command": [sys.executable, "runner.py"], "attempts": 2})
        final = self.proof()
        proof = final["not_reproduced"]
        proof["reruns"][1] = copy.deepcopy(proof["reruns"][0])
        proof["reruns"][1]["attempt"] = 2
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)
        proof["reruns"][0]["log"] = str(self.root / "outside.log")
        with self.assertRaises(ValueError):
            test_retry.verify(self.path, final)

    def test_non_test_failure_refuses_before_any_sample(self):
        self.receipt["checks"][0]["exit_code"] = 2
        self.assertIsNone(test_retry.run(self.path, self.receipt))
        self.assertFalse((self.root / "counter").exists())

    def test_directory_is_not_a_tracked_file(self):
        entry = self.receipt["test_report"]
        file = self.folder / "test-report" / entry["path"]
        file.write_text(file.read_text().replace('file="tests/a.py"', 'file="tests"'))
        entry["sha256"] = test_retry.hashed(file)
        entry["results"] = test_report.parse(file.read_bytes(), SETTINGS["identity"])
        self.assertIsNone(test_retry.run(self.path, self.receipt))

    def test_stop_reaps_the_active_subprocess_group(self):
        os.environ["RETRY_MODE"] = "sleep"
        result = []
        worker = threading.Thread(target=lambda: result.append(test_retry.run(self.path, self.receipt)))
        worker.start()
        try:
            deadline = time.monotonic() + 5
            while test_retry._active is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNotNone(test_retry._active)
            self.assertTrue(test_retry.stop())
        finally:
            worker.join(15)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [None])
        self.assertTrue(test_retry.stop())
