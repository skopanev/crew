"""Exercise competing Git publishers without a shared filesystem lock."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest

import test_gates as fixtures


class LandingRaceTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.GateTests("test_receipt_identifies_checked_tree_commands_and_log")
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.root, self.repo, self.env = self.case.root, self.case.repo, self.case.env
        self.git, self.gate = self.case.git, self.case.gate
        self.real_git = shutil.which("git")
        self.remote, self.other = self.root / "origin.git", self.root / "other"
        subprocess.run([self.real_git, "init", "--bare", "-q", str(self.remote)], check=True)
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "-q", "origin", "HEAD:develop")
        subprocess.run([self.real_git, "clone", "-q", "--branch", "develop", str(self.remote), str(self.other)], check=True)
        self.other_git("config", "user.name", "Test")
        self.other_git("config", "user.email", "test@example.invalid")
        (self.other / "independent.txt").write_text("another host\n")
        self.other_git("add", ".")
        self.other_git("commit", "-qm", "other candidate")
        self.git("commit", "-qm", "reviewed candidate")
        self.candidate = self.git("rev-parse", "HEAD")
        self.gate("run")

    def other_git(self, *args):
        return subprocess.check_output([self.real_git, *args], cwd=self.other,
                                       env=self.env, text=True, stderr=subprocess.PIPE).strip()

    def shim(self, mode):
        bins = self.root / "bin"
        bins.mkdir()
        script = bins / "git"
        script.write_text(f'''#!{sys.executable}
import pathlib,subprocess,sys
real={self.real_git!r}
other={str(self.other)!r}
flag=pathlib.Path({str(self.root / 'triggered')!r})
args=sys.argv[1:]
if args[0]!='push' or flag.exists():
    sys.exit(subprocess.call([real,*args]))
flag.touch()
def other_git(*args):
    subprocess.run([real,'-C',other,*args],check=True)
if {mode!r}=='before':
    other_git('push','-q','origin','HEAD:develop')
rc=subprocess.call([real,*args])
if rc==0 and {mode!r}=='after':
    other_git('fetch','-q','origin','develop')
    other_git('rebase','FETCH_HEAD')
    other_git('push','-q','origin','HEAD:develop')
if rc==0 and {mode!r}=='lost-reply':
    print('connection lost after publication',file=sys.stderr)
    sys.exit(128)
sys.exit(rc)
''')
        script.chmod(0o755)
        self.env["PATH"] = str(bins) + os.pathsep + self.env["PATH"]

    def land(self):
        return subprocess.run(["bash", str(fixtures.LANE / "bin/land.sh"), "develop"],
                              cwd=self.repo, env=self.env, text=True, capture_output=True, timeout=15)

    def test_explicit_rejection_rebases_once_and_checks_the_combined_candidate(self):
        self.shim("before")
        artifacts = self.root / "run/artifacts"
        (artifacts / "reviewed-tree.txt").write_text(self.git("write-tree") + "\n" + self.candidate)
        self.env.update(TOOLING_ROOT=str(fixtures.LANE.parent), LANE_WORKTREE=str(self.repo))
        result = subprocess.run(["bash", str(fixtures.LANE / "bin/integrate.sh"), "develop"],
                                cwd=self.repo, env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("<signal:", result.stdout, result.stdout + result.stderr)
        self.assertIn("target moved before push", result.stderr)
        self.assertTrue((self.repo / "independent.txt").exists())
        self.assertEqual(self.git("ls-remote", "origin", "refs/heads/develop").split()[0], self.git("rev-parse", "HEAD"))
        self.gate("verify")

    def test_success_accepts_a_target_that_advanced_to_a_descendant(self):
        self.shim("after")
        result = self.land()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        after = self.git("ls-remote", "origin", "refs/heads/develop").split()[0]
        self.assertNotEqual(after, self.candidate)
        self.git("merge-base", "--is-ancestor", self.candidate, after)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.candidate)

    def test_lost_reply_remains_uncertain_even_if_the_push_landed(self):
        self.shim("lost-reply")
        result = self.land()
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        self.assertIn("publication outcome is uncertain", result.stderr)
        self.assertEqual(self.git("ls-remote", "origin", "refs/heads/develop").split()[0], self.candidate)

    def test_post_push_read_retries_without_repeating_push(self):
        for failures in (1, 3, 4):
            with self.subTest(failures=failures):
                bins = self.root / f"read-retry-{failures}"
                bins.mkdir()
                pushes, reads, sleeps = bins / "pushes", bins / "reads", bins / "sleeps"
                script = bins / "git"
                script.write_text(f'''#!{sys.executable}
import pathlib,subprocess,sys
args=sys.argv[1:]
pushes=pathlib.Path({str(pushes)!r})
reads=pathlib.Path({str(reads)!r})
if args[0]=='push':
    pushes.write_text(pushes.read_text()+'push\\n' if pushes.exists() else 'push\\n')
if args[0]=='ls-remote' and pushes.exists():
    count=int(reads.read_text())+1 if reads.exists() else 1
    reads.write_text(str(count))
    if count<={failures}:sys.exit(128)
sys.exit(subprocess.call([{self.real_git!r},*args]))
''')
                script.chmod(0o755)
                sleeper = bins / "sleep"
                sleeper.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> "{sleeps}"\n')
                sleeper.chmod(0o755)
                env = dict(self.env, PATH=str(bins) + os.pathsep + self.env["PATH"])
                result = subprocess.run(["bash", str(fixtures.LANE / "bin/land.sh"), "develop"],
                                        cwd=self.repo, env=env, text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 4 if failures == 4 else 0, result.stdout + result.stderr)
                self.assertEqual(pushes.read_text().splitlines(), ["push"])
                self.assertEqual(int(reads.read_text()), min(failures + 1, 4))
                self.assertEqual(sleeps.read_text().splitlines(), ["2", "5", "10"][:min(failures, 3)])
                if failures == 4:
                    self.assertIn("target read failed after publication", result.stderr)
                else:
                    self.assertIn("lane-push: OK", result.stdout)
                remote = subprocess.check_output([self.real_git, "ls-remote", "origin", "refs/heads/develop"],
                                                 cwd=self.repo, env=self.env, text=True).split()[0]
                self.assertEqual(remote, self.candidate)

    def test_simultaneous_server_ref_updates_cannot_overwrite_the_winner(self):
        entered, release = self.root / "entered", self.root / "release"
        hook = self.remote / "hooks/pre-receive"
        hook.write_text(f'''#!{sys.executable}
import pathlib,sys,time
line=sys.stdin.readline().split()
if line[1]=={self.candidate!r}:
    pathlib.Path({str(entered)!r}).touch()
    until=time.monotonic()+10
    while not pathlib.Path({str(release)!r}).exists():
        if time.monotonic()>until:sys.exit(1)
        time.sleep(.01)
''')
        hook.chmod(0o755)
        process = subprocess.Popen(["bash", str(fixtures.LANE / "bin/land.sh"), "develop"],
                                   cwd=self.repo, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            until = time.monotonic() + 5
            while not entered.exists() and time.monotonic() < until:
                time.sleep(.01)
            self.assertTrue(entered.exists(), "The first publisher did not reach the server hook")
            self.other_git("push", "-q", "origin", "HEAD:develop")
            winner = self.other_git("rev-parse", "HEAD")
            release.touch()
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 3, stdout + stderr)
            self.assertEqual(self.git("ls-remote", "origin", "refs/heads/develop").split()[0], winner)
            self.assertEqual(self.git("rev-parse", "HEAD"), self.candidate)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
