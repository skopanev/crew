"""Landing train with a fake Box: real Git fixtures, no Docker, NTK or network."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_failure_outcome import shell_body

TOOLING = Path(__file__).resolve().parents[2]


def load_train():
    sys.argv = ["x"]
    spec = importlib.util.spec_from_file_location("train_under_test", TOOLING / "lane-launcher/train.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


train = load_train()
GIT_ENV = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, env=GIT_ENV, text=True).strip()


class FakeBox:
    """Runs Box scripts with bash on the host; /workspace/train maps to a temp folder."""

    def __init__(self, config, work):
        self.config, self.work = config, work
        self.source = os.path.realpath(config["sourceRoot"])
        self.scripts = []

    def sh(self, script, logfile=None, timeout=3600, cwd="/workspace/train/repo"):
        script = script.replace("/workspace/train", self.work)
        cwd = cwd.replace("/workspace/train", self.work)
        self.scripts.append(script)
        os.makedirs(cwd, exist_ok=True)
        proc = subprocess.run(["bash", "-c", "set -euo pipefail; " + script], cwd=cwd, env=GIT_ENV,
                              capture_output=True, text=True, timeout=timeout)
        if logfile:
            with open(logfile, "a") as fh:
                fh.write(f"$ {script}\n{proc.stdout}{proc.stderr}\nrc={proc.returncode}\n")
        return proc

    def close(self):
        pass


class Fixture(unittest.TestCase):
    """A source root with one repository, its bare origin and a train state folder."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.source = self.root / "sources"
        self.origin = self.root / "origin.git"
        self.repo = self.source / "repo"
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "develop", str(self.origin)], check=True, env=GIT_ENV)
        git(self.repo, "init", "-q", "-b", "develop")
        (self.repo / ".ntkrc").write_text('{"target_branch":"develop"}\n')
        (self.repo / ".gitignore").write_text("cache/\n")
        (self.repo / "code.txt").write_text("base\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "base")
        git(self.repo, "remote", "add", "origin", str(self.origin))
        git(self.repo, "push", "-q", "origin", "develop")
        git(self.repo, "fetch", "-q", "origin")
        self.config = {"id": "fixture", "workspace": "fixture", "sourceRoot": str(self.source),
                       "stateDir": str(self.root / "state"), "gateCommands": ["true"],
                       "train": {"gateCommands": ["test -f code.txt"]}}
        self.train_dir = self.root / "train-dir"
        self.train_dir.mkdir()

    def write_config(self):
        path = self.root / "dolber.json"
        path.write_text(json.dumps(self.config))
        return train.load_config(str(path))


class SetupHookTests(Fixture):
    """Item 1: project-owned setup hooks replace Crew's former build-tool policy."""

    def test_generic_files_carry_no_build_tool_policy(self):
        words = ("gradle", "idletimeout", "kotlin")
        for name in ("lane/workflow.yaml", "lane-launcher/train.py", "lane/run.sh",
                     "lane-launcher/runtime.mjs", "lane-launcher/README.md", "lane/bin/gates.py"):
            text = (TOOLING / name).read_text().lower()
            for word in words:
                self.assertNotIn(word, text, f"{word} in {name}")

    def test_persistent_mounts_are_validated_and_mounted(self):
        cache = self.root / "lander-cache"
        self.config["train"]["persistentMounts"] = [{"host": str(cache), "inside": "/home/medulla/.cache-x"}]
        self.config["sshDir"] = str(self.root)
        self.config["image"] = "fixture-image"
        config = self.write_config()
        self.assertTrue(cache.is_dir())
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="container-id\n", stderr="")
        with mock.patch.object(train.subprocess, "run", fake_run):
            train.Box(config, str(self.root / "work"))
        self.assertIn(f"{cache}:/home/medulla/.cache-x:rw", calls[0])
        for bad in ({"host": "relative", "inside": "/x"}, {"host": str(cache), "inside": "/workspace/train/x"},
                    {"host": str(cache), "inside": "/x", "extra": 1}, {"host": str(cache) + ":/y", "inside": "/x"}):
            with self.subTest(bad=bad):
                self.config["train"]["persistentMounts"] = [bad]
                with self.assertRaises(SystemExit):
                    self.write_config()

    def test_train_setup_runs_before_candidates_and_may_not_dirty_the_checkout(self):
        self.config["train"]["setup"] = 'mkdir -p cache && echo "$LANDING_TRAIN" > cache/marker'
        config = self.write_config()
        box = FakeBox(config, str(self.root / "work"))
        target, base = train.prepare(box, config, str(self.train_dir / "log"))
        self.assertEqual(target, "develop")
        self.assertEqual((self.root / "work/repo/cache/marker").read_text(), "true\n")
        # MUST-REFUSE: setup that edits a tracked file stops the train.
        self.config["train"]["setup"] = "echo changed > code.txt"
        config = self.write_config()
        with self.assertRaisesRegex(RuntimeError, "changed the checkout"):
            train.prepare(FakeBox(config, str(self.root / "work")), config, str(self.train_dir / "log"))
        self.config["train"]["setup"] = "exit 7"
        config = self.write_config()
        with self.assertRaisesRegex(RuntimeError, "train.setup failed"):
            train.prepare(FakeBox(config, str(self.root / "work")), config, str(self.train_dir / "log"))


class LaneSetupTests(unittest.TestCase):
    """The workflow runs laneSetup inside the lane after checkout; failure stops the lane."""

    def run_create(self, setup):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            origin, project, worktree, run = root / "origin.git", root / "project", root / "wt", root / "run"
            for folder in (project, worktree, run / "artifacts", root / "home"):
                folder.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", "--bare", "-b", "develop", str(origin)], check=True, env=GIT_ENV)
            git(project, "init", "-q", "-b", "develop")
            (project / ".ntkrc").write_text('{"target_branch":"develop"}\n')
            git(project, "add", ".")
            git(project, "commit", "-qm", "base")
            git(project, "remote", "add", "origin", str(origin))
            git(project, "push", "-q", "origin", "develop")
            env = dict(GIT_ENV, HOME=str(root / "home"), project_dir=str(project), ticket_id="fixture",
                       LANE_WORKTREE=str(worktree), MEDULLA_RUN_DIR=str(run), TICKET_CHECKS="[]",
                       GIT_SSH_COMMAND="", TRAIN_GATES_ONLY="true", LANE_SETUP=setup)
            result = subprocess.run(["bash", "-c", shell_body("create_worktree")], env=env, cwd=root,
                                    capture_output=True, text=True, timeout=60)
            marker = root / "home/marker"
            log = run / "artifacts/lane-setup.txt"
            return (result, marker.read_text() if marker.exists() else None,
                    log.read_text() if log.exists() else None)

    def test_lane_setup_runs_in_checkout_with_lane_environment(self):
        result, marker, _ = self.run_create(
            'test -f .ntkrc && echo "$TRAIN_GATES_ONLY $(basename "$LANE_WORKTREE")" > "$HOME/marker"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("<signal:READY>", result.stdout)
        self.assertEqual(marker, "true wt\n")

    def test_empty_lane_setup_runs_nothing(self):
        result, marker, log = self.run_create("")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("<signal:READY>", result.stdout)
        self.assertIsNone(log)

    def test_failing_lane_setup_stops_the_lane(self):
        result, _, log = self.run_create("echo seed failed; false")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("<signal:READY>", result.stdout)
        self.assertIn("laneSetup", result.stderr)
        self.assertIn("seed failed", log)


if __name__ == "__main__":
    unittest.main()
