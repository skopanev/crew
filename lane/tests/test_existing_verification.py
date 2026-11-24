"""Verify recorded Test paths with real Git objects and package directories."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LANE = Path(__file__).resolve().parents[1]


class ExistingVerificationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.artifacts = self.root / "run/artifacts"
        self.artifacts.mkdir(parents=True)
        self.file = "apps/app/src/app/[locale]/(app)/wallet/swap.test.tsx"
        self.title = "shows time to confirm with the quote"
        file = self.repo / self.file
        file.parent.mkdir(parents=True)
        file.write_text(f"test('{self.title}', () => {{}});\n")
        self.env = dict(os.environ, MEDULLA_RUN_DIR=str(self.root / "run"),
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        for args in [("init", "-q"), ("add", "."),
                     ("-c", "user.name=test", "-c", "user.email=test@local", "commit", "-qm", "fixture")]:
            subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True)
        self.test = {"title": "Web quote time", "body": f"Reporter name: {self.file} > suite > {self.title}",
                     "command": "cd apps/app && bunx vitest run 'src/app/[locale]/(app)/wallet/swap.test.tsx' -t 'shows time$'"}

    def existing(self, tests, success=True):
        (self.artifacts / "ticket.json").write_text(json.dumps({"acceptanceTests": tests}))
        result = subprocess.run([sys.executable, str(LANE / "bin/gates.py"), "existing"],
                                cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=10)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((self.artifacts / "ticket-checks.json").read_text()), [self.file])
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertFalse((self.artifacts / "ticket-checks.json").exists())
        return result

    def test_package_command_resolves_reporter_file_from_its_directory(self):
        self.existing([self.test])

    def test_root_command_keeps_literal_reporter_path(self):
        self.test["command"] = f"bun run test '{self.file}'"
        self.existing([self.test])

    def test_package_command_without_reporter_resolves_its_final_file(self):
        self.test.update(title=self.title, body="", command="cd apps/app && bun run test 'src/app/[locale]/(app)/wallet/swap.test.tsx'")
        self.existing([self.test])

    def test_other_command_file_does_not_satisfy_reporter(self):
        self.test["command"] = "cd apps/app && bunx vitest run src/other.test.tsx"
        result = self.existing([self.test], False)
        self.assertIn("Reporter file differs", result.stderr)

    def test_missing_reporter_case_does_not_select_the_file(self):
        self.test["body"] = f"Reporter name: {self.file} > missing case"
        result = self.existing([self.test], False)
        self.assertIn("absent at HEAD", result.stderr)

    def test_outside_or_invalid_command_directory_is_refused(self):
        for directory in ["../outside", "/tmp", "missing"]:
            with self.subTest(directory=directory):
                self.test["command"] = f"cd {directory} && bun test '{self.file}'"
                self.existing([self.test], False)

    def test_task_without_recorded_tests_does_not_enter_verification(self):
        result = self.existing([], False)
        self.assertIn("every Task needs recorded acceptanceTests", result.stderr)


if __name__ == "__main__":
    unittest.main()
