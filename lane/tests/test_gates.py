"""Real Git fixtures; no network, queues, Docker, or agent harnesses."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_failure_outcome import shell_body

LANE = Path(__file__).resolve().parents[1]


class GateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, MEDULLA_RUN_DIR=str(self.root / "run"),
                        ticket_id="fixture-task", project_dir=str(self.repo),
                        module_name="fixture-module", gate_commands='["printf passed"]',
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / "code.txt").write_text("original\n")
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        (self.repo / "code.txt").write_text("candidate\n")
        self.git("add", ".")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo,
                                       env=self.env, text=True).strip()

    def gate(self, mode, *, succeeds=True):
        result = subprocess.run([sys.executable, str(LANE / "bin/gates.py"), mode],
                                cwd=self.repo, env=self.env, capture_output=True,
                                text=True, timeout=10)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def receipt(self):
        root = self.root / "run/artifacts/gates"
        pointer = json.loads((root / "current.json").read_text())
        return json.loads(Path(pointer["receipt"]).read_text())

    def test_receipt_identifies_checked_tree_commands_and_log(self):
        self.gate("run")
        receipt = self.receipt()
        self.assertEqual(receipt["tree"], self.git("write-tree"))
        self.assertEqual(self.git("rev-parse", receipt["candidate_sha"] + "^{tree}"),
                         receipt["tree"])
        self.assertEqual(receipt["checks"][0]["exit_code"], 0)
        self.assertEqual(Path(receipt["checks"][0]["log"]).read_text(), "passed")
        self.gate("verify")
        self.git("commit", "-qm", "reviewed candidate")
        self.gate("verify")

    def test_failure_keeps_actual_rc_and_invalidates_old_pass(self):
        self.gate("run")
        self.env["gate_commands"] = '["echo failed; exit 23"]'
        self.gate("run", succeeds=False)
        self.gate("verify", succeeds=False)
        receipts = [json.loads(p.read_text()) for p in
                    (self.root / "run/artifacts/gates").glob("*/receipt.json")]
        failed = [r for r in receipts if not r["passed"]]
        self.assertEqual(failed[0]["checks"][0]["exit_code"], 23)

    def test_pipeline_failure_cannot_hide_behind_successful_last_command(self):
        self.env["gate_commands"] = '["false | cat"]'
        self.gate("run", succeeds=False)

    def test_absent_plan_cannot_reuse_old_pass(self):
        self.gate("run")
        self.env["gate_commands"] = "[]"
        self.gate("run", succeeds=False)
        self.gate("verify", succeeds=False)

    def test_gate_mutation_needs_new_candidate(self):
        self.env["gate_commands"] = '["echo changed > code.txt; git add code.txt"]'
        self.gate("run", succeeds=False)
        self.gate("verify", succeeds=False)

    def test_changes_after_pass_require_new_checks(self):
        self.gate("run")
        (self.repo / "code.txt").write_text("later change\n")
        self.gate("verify", succeeds=False)
        self.git("add", ".")
        self.gate("verify", succeeds=False)
        self.gate("run")
        self.gate("verify")

    def test_plan_scope_or_log_change_cannot_reuse_receipt(self):
        self.gate("run")
        for key, value in (("ticket_id", "other-task"), ("module_name", "other-module"),
                           ("gate_commands", '["true"]')):
            with self.subTest(field=key):
                before = self.env[key]
                self.env[key] = value
                self.gate("verify", succeeds=False)
                self.env[key] = before
        Path(self.receipt()["checks"][0]["log"]).write_text("replaced")
        self.gate("verify", succeeds=False)

    def test_landing_refuses_commit_hook_mutation_before_contacting_remote(self):
        self.gate("run")
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text('#!/bin/sh\necho hook-change > code.txt\ngit add code.txt\n')
        hook.chmod(0o755)
        self.git("commit", "-qm", "hook changed candidate")
        result = subprocess.run(["bash", str(LANE / "bin/land.sh"), "develop"],
                                cwd=self.repo, env=self.env, capture_output=True,
                                text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("candidate changed", result.stderr)
        self.assertNotIn("lane-push: HEAD=", result.stdout)

    def test_clean_rebase_returns_to_checks_and_review_before_any_push(self):
        # The origin is another directory in this disposable fixture.
        remote = self.root / "origin.git"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-q", "origin", "HEAD:develop")
        initial = self.git("rev-parse", "HEAD")
        self.gate("run")
        artifacts = self.root / "run/artifacts"
        (artifacts / "reviewed-tree.txt").write_text(self.git("write-tree") + "\n" + initial)
        # Advance the target independently while the panel reviews the candidate.
        other = self.root / "other"
        subprocess.run(["git", "clone", "-q", "--branch", "develop", str(remote), str(other)],
                       check=True)
        (other / "independent.txt").write_text("target moved\n")
        for args in (("add", "."), ("-c", "user.name=Test", "-c",
                     "user.email=test@example.invalid", "commit", "-qm", "other work"),
                     ("push", "-q")):
            subprocess.run(["git", *args], cwd=other, env=self.env, check=True)
        moved = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=other,
                                        text=True).strip()
        bins = self.root / "bin"
        bins.mkdir()
        worktrees = self.root / "worktrees"
        worktrees.mkdir()
        (worktrees / "wt-fixture-task").symlink_to(self.repo, target_is_directory=True)
        self.env.update(PATH=str(bins) + os.pathsep + self.env["PATH"],
                        TOOLING_ROOT=str(LANE.parent), LANE_WORKTREE=str(self.repo),
                        project_name="fixture", ticket_title="fixture")
        result = subprocess.run(["bash", "-c", shell_body("git_landing")],
                                cwd=self.repo, env=self.env, capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("<signal:REBASED>", result.stdout)
        self.assertEqual(self.git("ls-remote", "origin", "refs/heads/develop").split()[0],
                         moved)
        self.gate("verify", succeeds=False)
        (artifacts / "qa-contract.txt").write_text("fixture QA context")
        result = subprocess.run(["bash", "-c", shell_body("prepare_review")],
                                cwd=self.repo, env=self.env, capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("<signal:SNAPSHOT>", result.stdout)
        self.gate("verify")
        self.assertEqual(self.receipt()["tree"], self.git("rev-parse", "HEAD^{tree}"))

    def test_launcher_refuses_missing_checks_before_reading_queue(self):
        self.env["LANE_RUNS_FOLDER"] = str(self.root / "launcher-runs")
        (self.root / "shared-cbm.py").write_text("# fixture connector\n")
        result = subprocess.run(["bash", str(LANE / "run.sh"), "--ticket-id", "fixture",
                                 "--project", "fixture", "--mount-rw", str(self.repo),
                                 "--cbm-mcp-command", str(self.root / "shared-cbm.py")],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--gate-command is required before claiming work", result.stderr)

    def test_review_requires_nonempty_equill_contract(self):
        bins = self.root / "bin"
        bins.mkdir()
        equill = bins / "equill"
        equill.write_text('#!/bin/sh\nprintf "%s" "$QA_RESPONSE"\nexit "$QA_RC"\n')
        equill.chmod(0o755)
        worktrees = self.root / "worktrees"
        worktrees.mkdir()
        (worktrees / "wt-fixture-task").symlink_to(self.repo, target_is_directory=True)
        self.env.update(PATH=str(bins) + os.pathsep + self.env["PATH"],
                        TOOLING_ROOT=str(LANE.parent), LANE_WORKTREE=str(self.repo))
        for content, rc in (("", 0), (" \n", 0), ("fixture QA contract", 1),
                            ("fixture QA contract", 0)):
            with self.subTest(content=content, rc=rc):
                self.env.update(QA_RESPONSE=json.dumps({"content": content}), QA_RC=str(rc))
                result = subprocess.run(["bash", "-c", shell_body("prepare_review")],
                                        cwd=self.repo, env=self.env, capture_output=True,
                                        text=True, timeout=15)
                contract = self.root / "run/artifacts/qa-contract.txt"
                if content.strip() and rc == 0:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(contract.read_text().strip(), content)
                    self.assertIn("<signal:SNAPSHOT>", result.stdout)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("QA contract unavailable", result.stderr)
                    self.assertFalse(contract.exists())
                    self.assertNotIn("<signal:SNAPSHOT>", result.stdout)


if __name__ == "__main__":
    unittest.main()
