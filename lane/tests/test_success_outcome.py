"""The real success node persists landing results without a message bus."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_failure_outcome import shell_body


class SuccessOutcomeTests(unittest.TestCase):
    def run_success(self, signal, *, bus_installed=False, report_unwritable=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = root / "bin"
            commands.mkdir()
            if bus_installed:
                bus = commands / "agentbus"
                bus.write_text('#!/bin/sh\ntouch "$BUS_CALLED"\nexit 99\n')
                bus.chmod(0o755)
            artifacts = root / "run/artifacts"
            artifacts.mkdir(parents=True)
            (artifacts / "panel.md").write_text(
                "- MED follow-up improvement\n- LOW useful observation\n"
            )
            if report_unwritable:
                (artifacts / "outcome.txt").mkdir()
            env = dict(os.environ, PATH=f"{commands}:/usr/bin:/bin",
                       MEDULLA_RUN_DIR=str(root / "run"),
                       MEDULLA_LAST_SIGNAL=signal,
                       MEDULLA_LAST_MESSAGE="landed deadbeef on develop",
                       ticket_id="fixture-task", BUS_CALLED=str(root / "bus-called"))
            result = subprocess.run(
                ["bash", "-c", shell_body("notify_success")],
                env=env, cwd=root, capture_output=True, text=True, timeout=5,
            )
            self.assertFalse((root / "bus-called").exists())
            report = artifacts / "outcome.txt"
            return result, report.read_text() if report.is_file() else None

    def test_landing_succeeds_without_bus_or_with_broken_bus(self):
        for installed in (False, True):
            with self.subTest(bus_installed=installed):
                result, report = self.run_success("LANDED", bus_installed=installed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("deadbeef on develop", report)
                self.assertIn("Неблокирующих находок 2", report)
                self.assertEqual(result.stdout, report)

    def test_landing_with_failed_state_write_cannot_report_success(self):
        result, report = self.run_success("LANDED_TICKET_STUCK")
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)

    def test_failed_report_write_is_not_hidden_by_successful_stdout(self):
        result, report = self.run_success("LANDED", report_unwritable=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)


if __name__ == "__main__":
    unittest.main()
