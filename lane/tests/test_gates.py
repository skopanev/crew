"""Real Git fixtures; no network, queues, Docker, or agent harnesses."""

import json
import fcntl
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
                        ticket_id="fixture-task", project_name="fixture", project_dir=str(self.repo),
                        module_name="fixture-module", gate_commands='["printf passed"]',
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / "code.txt").write_text("original\n")
        (self.repo / ".ntkrc").write_text('{"target_branch":"develop"}\n')
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

    def test_duplicate_checks_cannot_replace_required_repository_gates(self):
        artifacts = self.root / "run/artifacts"
        artifacts.mkdir(parents=True)
        (artifacts / "ticket-checks.json").write_text(json.dumps([
            {"ac": "criterion:required", "argv": ["grep", "-Fq", "--", "candidate", "code.txt"]}
        ]))
        self.env.update(VERIFY_ONLY="true", gate_commands='["exit 23"]')
        self.gate("run", succeeds=False)
        self.gate("verify", succeeds=False)

    def test_duplicate_receipt_contains_repository_and_ticket_checks(self):
        artifacts = self.root / "run/artifacts"
        artifacts.mkdir(parents=True)
        check = {"ac": "criterion:required", "argv": ["test", "-f", "code.txt"]}
        (artifacts / "ticket-checks.json").write_text(json.dumps([check]))
        self.env["VERIFY_ONLY"] = "true"
        self.gate("run")
        self.assertEqual(self.receipt()["commands"], ["printf passed", check])
        self.gate("verify")

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

    def test_clean_rebase_runs_fresh_checks_before_pushing_without_new_review(self):
        self.check_rebased_landing(False)

    def test_failed_post_rebase_checks_leave_the_remote_target_unchanged(self):
        self.check_rebased_landing(True)

    def check_rebased_landing(self, failing):
        # The origin is another directory in this disposable fixture.
        remote = self.root / "origin.git"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-q", "origin", "HEAD:develop")
        self.git("commit", "-qm", "candidate")
        initial = self.git("rev-parse", "HEAD")
        if failing:
            self.env['gate_commands'] = '["test ! -f independent.txt"]'
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
                        project_name="fixture", ticket_title="fixture",
                        LANE_SHARED_LOCK_DIR=str(self.root / 'locks'))
        (self.root / 'locks').mkdir()
        # integrate.sh runs while its caller holds the target lock.
        with (self.root / 'locks/target.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run(["bash", str(LANE / 'bin/integrate.sh'), 'develop'],
                                    cwd=self.repo, env=self.env, capture_output=True,
                                    text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        if failing:
            self.assertIn('<signal:GATE_FAIL>', result.stdout)
            self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/develop').split()[0], moved)
            self.gate('verify', succeeds=False)
            return
        self.assertNotIn('<signal:REBASED>', result.stdout)
        self.assertNotIn('<signal:LAND_FAILED>', result.stdout, result.stderr)
        landed = self.git('rev-parse', 'HEAD')
        self.assertNotEqual(landed, initial)
        self.assertEqual(self.git("ls-remote", "origin", "refs/heads/develop").split()[0], landed)
        self.git('merge-base', '--is-ancestor', moved, landed)
        self.gate("verify")
        self.assertEqual(self.receipt()["tree"], self.git("rev-parse", "HEAD^{tree}"))

    def test_launcher_refuses_missing_checks_before_reading_queue(self):
        self.env["LANE_RUNS_FOLDER"] = str(self.root / "launcher-runs")
        (self.root / "shared-cbm.py").write_text("# fixture connector\n")
        (self.root / "shared-cbm.py").chmod(0o755)
        result = subprocess.run(["bash", str(LANE / "run.sh"), "--ticket-id", "fixture",
                                 "--project", "fixture", "--source-root", str(self.root),
                                 "--cbm-mcp-command", str(self.root / "shared-cbm.py"),
                                 "--cbm-cache-dir", str(self.root), "--shared-lock-dir", str(self.root / "locks")],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--gate-command is required", result.stderr)

    def test_launcher_rejects_removed_repository_flags(self):
        # Passthrough would otherwise hand Medulla a writable source mount.
        for flag in ("--repo", f"--repo={self.repo}"):
            with self.subTest(flag=flag):
                args = [flag] if "=" in flag else [flag, str(self.repo)]
                result = subprocess.run(["bash", str(LANE / "run.sh"), "--ticket-id", "fixture",
                                         *args], env=self.env, capture_output=True,
                                        text=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertIn("was removed; use --source-root", result.stderr)

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
                        TOOLING_ROOT=str(LANE.parent), LANE_WORKTREE=str(self.repo), DELIVERY='branch')
        self.git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
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
