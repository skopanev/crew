"""Gate-bound JUnit reports: real gates.py runs on a Git fixture."""

import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

LANE = Path(__file__).resolve().parents[1]
CONFIG = {"path": "junit/report.xml", "format": "junit", "identity": "{file} > {name}"}
REPORT = """<testsuites><testsuite name="unit" file="tests/b.test.ts">
<testcase name="adds" file="tests/a.test.ts" time="0.25"/>
<testcase name="breaks" file="tests/a.test.ts" time="1"><failure message="expected 2">trace line</failure></testcase>
<testcase name="later" file="tests/a.test.ts"><skipped/></testcase>
<testcase name="crashes" file="tests/a.test.ts"><error message="boom"/></testcase>
</testsuite></testsuites>"""


class TestReportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, MEDULLA_RUN_DIR=str(self.root / "run"),
                        ticket_id="fixture-task", project_name="fixture", project_dir=str(self.repo),
                        module_name="fixture-module", test_report=json.dumps(CONFIG),
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.env.pop("CREW_TEST_REPORT_DIR", None)
        for args in (["init", "-q"], ["config", "user.name", "Test"],
                     ["config", "user.email", "test@example.invalid"]):
            self.git(*args)
        (self.repo / "code.txt").write_text("candidate\n")
        self.git("add", ".")
        self.git("commit", "-qm", "initial")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, env=self.env, text=True).strip()

    def gate(self, command):
        """Run one gate command; the report never changes the gate verdict."""
        self.env["gate_commands"] = json.dumps([command])
        result = subprocess.run([sys.executable, str(LANE / "bin/gates.py"), "run"], cwd=self.repo,
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        pointer = json.loads((self.root / "run/artifacts/gates/current.json").read_text())
        return json.loads(Path(pointer["receipt"]).read_text())

    def write(self, content, extra=""):
        source = self.root / "source.xml"
        source.write_text(content)
        return (f'mkdir -p "$CREW_TEST_REPORT_DIR/junit" && cp {extra} {shlex.quote(str(source))} '
                f'"$CREW_TEST_REPORT_DIR/junit/report.xml"')

    def test_report_is_parsed_hashed_and_bound_to_the_receipt(self):
        receipt = self.gate(self.write(REPORT))
        report = receipt["test_report"]
        self.assertNotIn("error", report)
        folder = Path((self.root / "run/artifacts/gates").glob("*/receipt.json").__next__()).parent
        raw = folder / "test-report/junit/report.xml"
        self.assertEqual(report["sha256"], hashlib.sha256(raw.read_bytes()).hexdigest())
        self.assertEqual(report["results"], [
            {"test": "tests/a.test.ts > adds", "outcome": "pass", "time": 0.25},
            {"test": "tests/a.test.ts > breaks", "outcome": "fail", "message": "expected 2\ntrace line", "time": 1.0},
            {"test": "tests/a.test.ts > later", "outcome": "skip"},
            {"test": "tests/a.test.ts > crashes", "outcome": "fail", "message": "boom"}])

    def test_suite_attributes_are_explicit_placeholders(self):
        self.env["test_report"] = json.dumps({**CONFIG, "identity": "{suite.file} > {name}"})
        names = [r["test"] for r in self.gate(self.write(REPORT))["test_report"]["results"]]
        self.assertEqual(names[0], "tests/b.test.ts > adds")

    def assert_refused(self, command, fragment):
        report = self.gate(command)["test_report"]
        self.assertNotIn("results", report)
        self.assertIn(fragment, report["error"])

    def test_missing_report_records_an_error_and_the_gate_still_passes(self):
        self.assert_refused("true", "report is missing")

    def test_empty_report_is_refused(self):
        self.assert_refused(self.write("  \n"), "report is empty")

    def test_unparsable_report_is_refused(self):
        self.assert_refused(self.write("<testsuites><testcase"), "not valid XML")

    def test_report_without_cases_is_refused(self):
        self.assert_refused(self.write("<testsuites/>"), "no testcase")

    def test_stale_report_is_refused(self):
        source = self.root / "source.xml"
        command = self.write(REPORT, "-p")
        os.utime(source, (946684800, 946684800))
        self.assert_refused(command, "stale")

    def test_ambiguous_report_is_refused(self):
        self.env["test_report"] = json.dumps({**CONFIG, "identity": "{file} > x"})
        self.assert_refused(self.write(REPORT), "ambiguous report")

    def test_missing_identity_attribute_is_refused(self):
        self.env["test_report"] = json.dumps({**CONFIG, "identity": "{path} > {name}"})
        self.assert_refused(self.write(REPORT), "has no path attribute")

    def test_report_folder_is_fresh_and_exported_only_when_configured(self):
        receipt = self.gate('test -d "$CREW_TEST_REPORT_DIR" && test -z "$(ls -A "$CREW_TEST_REPORT_DIR")"')
        self.assertTrue(receipt["passed"])
        del self.env["test_report"]
        receipt = self.gate('test -z "${CREW_TEST_REPORT_DIR:-}"')
        self.assertNotIn("test_report", receipt)

    def test_invalid_config_is_recorded_without_changing_the_gate(self):
        self.env["test_report"] = json.dumps({**CONFIG, "path": "../escape.xml"})
        self.assert_refused("true", "invalid testReport config")


if __name__ == "__main__":
    unittest.main()
