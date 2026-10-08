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
        # Trains live under the lander's train directory, as main() creates them.
        self.train_dir = self.root / "state/crew-dispatchers/fixture/train/train-1"
        self.train_dir.mkdir(parents=True)

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

    def protected_layout(self):
        dirs = {name: self.root / name for name in ("ssh", "cbm", "context", "rw-cache", "lander")}
        for path in dirs.values():
            path.mkdir()
        self.config.update(sshDir=str(dirs["ssh"]), cbmCacheDir=str(dirs["cbm"]), image="fixture-image",
                           readOnlyRepos=[str(dirs["context"])], readWriteDirs=[str(dirs["rw-cache"])])
        (self.root / "alias").symlink_to(self.source, target_is_directory=True)
        return dirs

    def test_persistent_mounts_are_validated_and_mounted(self):
        dirs = self.protected_layout()
        cache = dirs["lander"] / "cache"
        self.config["train"]["persistentMounts"] = [{"host": str(cache), "inside": "/home/medulla/.cache-x"}]
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

    def test_persistent_mounts_may_not_alias_protected_or_writable_dirs(self):
        dirs = self.protected_layout()
        aliases = {"sourceRoot": self.source, "child of sourceRoot": self.source / "repo",
                   "parent of sourceRoot": self.root, "symlink to sourceRoot": self.root / "alias",
                   "missing child of sourceRoot": self.source / "new/cache",
                   "sshDir": dirs["ssh"], "child of cbmCacheDir": dirs["cbm"] / "x",
                   "readOnlyRepos": dirs["context"], "child of readWriteDirs": dirs["rw-cache"] / "sub"}
        for case, host in aliases.items():
            with self.subTest(case=case):
                self.config["train"]["persistentMounts"] = [{"host": str(host), "inside": "/cache"}]
                with self.assertRaises(SystemExit) as refused:
                    self.write_config()
                self.assertIn("overlaps", str(refused.exception))
                self.assertFalse((self.source / "new").exists())
        with self.subTest(case="two mounts overlap each other"):
            self.config["train"]["persistentMounts"] = [{"host": str(dirs["lander"]), "inside": "/a"},
                                                        {"host": str(dirs["lander"] / "b"), "inside": "/b"}]
            with self.assertRaises(SystemExit):
                self.write_config()
        self.config["train"]["persistentMounts"] = [{"host": str(dirs["lander"] / "a"), "inside": "/a"},
                                                    {"host": str(self.root / "elsewhere"), "inside": "/b"}]
        config = self.write_config()
        self.assertEqual(len(config["train"]["persistentMounts"]), 2)

    def test_train_setup_runs_before_candidates_and_may_not_dirty_the_checkout(self):
        self.config["train"]["setup"] = 'mkdir -p cache && echo "$LANDING_TRAIN" > cache/marker'
        config = self.write_config()
        box = FakeBox(config, str(self.root / "work"))
        target, base = train.prepare(box, config, "repo", str(self.train_dir / "log"))
        self.assertEqual(target, "develop")
        self.assertEqual((self.root / "work/repo/cache/marker").read_text(), "true\n")
        # MUST-REFUSE: setup that edits a tracked file stops the train.
        self.config["train"]["setup"] = "echo changed > code.txt"
        config = self.write_config()
        with self.assertRaisesRegex(RuntimeError, "changed the checkout"):
            train.prepare(FakeBox(config, str(self.root / "work")), config, "repo", str(self.train_dir / "log"))
        self.config["train"]["setup"] = "exit 7"
        config = self.write_config()
        with self.assertRaisesRegex(RuntimeError, "train.setup failed"):
            train.prepare(FakeBox(config, str(self.root / "work")), config, "repo", str(self.train_dir / "log"))


class TrainFixture(Fixture):
    """Lanes queue real requests through the workflow's git_landing node; the lander uses a fake Box."""

    def setUp(self):
        super().setUp()
        self.config.update(gateCommands=["test -f code.txt"], testCommand=["bash"])
        self.config["train"] = {"gateCommands": ["true"]}
        self.bins = self.root / "bin"
        self.bins.mkdir()
        self.calls = self.root / "calls.txt"
        for name in ("node", "ntk"):
            tool = self.bins / name
            tool.write_text(f'#!/bin/sh\necho "{name} $*" >> "{self.calls}"\n')
            tool.chmod(0o755)
        patcher = mock.patch.dict(os.environ, {"PATH": f"{self.bins}{os.pathsep}{os.environ['PATH']}"})
        patcher.start()
        self.addCleanup(patcher.stop)
        box = mock.patch.object(train, "Box", FakeBox)
        box.start()
        self.addCleanup(box.stop)

    def lane(self, ticket, files, *, deferred=False, ticket_checks=None, coder_checks=None, repo=None):
        """Run one lane's tail for real: commit, gates.py run, git_landing in train mode."""
        config = self.write_config()
        repo = repo or self.repo
        wt = self.source / ".worktrees" / ticket
        wt.parent.mkdir(exist_ok=True)
        subprocess.run(["git", "clone", "-q", str(repo), str(wt)], check=True, env=GIT_ENV)
        git(wt, "remote", "set-url", "origin", git(repo, "remote", "get-url", "origin"))
        git(wt, "fetch", "-q", "origin")
        for name, text in files.items():
            (wt / name).write_text(text)
        git(wt, "add", "-A")
        git(wt, "commit", "-qm", f"{ticket}: change")
        run = Path(config["scopeDir"]) / "runs" / f"launch-{ticket}" / "lane" / "run-1"
        artifacts = run / "artifacts"
        artifacts.mkdir(parents=True)
        if ticket_checks is not None:
            (artifacts / "ticket-checks.json").write_text(json.dumps(ticket_checks))
        if coder_checks is not None:
            (artifacts / "coder-checks.json").write_text(json.dumps(coder_checks))
        env = dict(GIT_ENV, MEDULLA_RUN_DIR=str(run), ticket_id=ticket, project_dir=str(repo),
                   module_name=repo.name, repository=repo.name, gate_commands=json.dumps(self.config["gateCommands"]),
                   ticket_test_command=json.dumps(self.config["testCommand"]),
                   TRAIN_GATES_ONLY="true" if deferred else "false", VERIFY_ONLY="false",
                   LAND_MODE="train", TOOLING_ROOT=str(TOOLING), LANE_WORKTREE=str(wt),
                   GIT_SSH_COMMAND="", project_name="fixture", ticket_title=ticket)
        gate = subprocess.run([sys.executable, str(TOOLING / "lane/bin/gates.py"), "run"], cwd=wt, env=env,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(gate.returncode, 0, gate.stderr)
        (artifacts / "reviewed-tree.txt").write_text(git(wt, "write-tree") + "\n" + git(wt, "rev-parse", "HEAD"))
        landing = subprocess.run(["bash", "-c", shell_body("git_landing")], cwd=wt, env=env,
                                 capture_output=True, text=True, timeout=60)
        self.assertEqual(landing.returncode, 0, landing.stderr)
        self.assertIn("<signal:QUEUED>", landing.stdout)
        return artifacts

    def request(self, artifacts):
        return json.loads((artifacts / "train-request.json").read_text())

    def result(self, artifacts):
        path = artifacts / "train-result.json"
        return json.loads(path.read_text()) if path.exists() else None

    def land(self):
        config = self.write_config()
        train.land_queue(config, train.queued(config), str(self.train_dir))
        return config

    def remote_head(self):
        return git(self.repo, "ls-remote", str(self.origin), "refs/heads/develop").split()[0]

    def receipts(self):
        return [json.loads(p.read_text()) for p in sorted(self.train_dir.glob("receipt-*.json"))]


class TrainVerificationTests(TrainFixture):
    """Items 3 and 2: every candidate's receipt is verified and its own plan runs on the integrated tree."""

    def test_request_binds_receipt_digest_repository_and_module(self):
        artifacts = self.lane("t1", {"a.txt": "a\n"})
        request = self.request(artifacts)
        self.assertEqual(request["gate_receipt_sha256"],
                         hashlib.sha256(Path(request["gate_receipt"]).read_bytes()).hexdigest())
        self.assertEqual(request["project_dir"], str(self.repo))
        self.assertEqual(request["module"], "repo")
        self.assertNotIn("gate_plan", request)

    def test_train_runs_union_of_train_gates_and_every_candidate_plan(self):
        structured = {"ac": "AC1", "argv": ["git", "ls-files", "--", "b.txt"], "stdout": "b.txt\n"}
        normal = self.lane("t1", {"a.txt": "a\n"})
        deferred = self.lane("t2", {"b.txt": "b\n", "t.sh": "test -f b.txt\n"}, deferred=True,
                             ticket_checks=["t.sh", structured], coder_checks=["test -f a.txt"])
        before = self.remote_head()
        self.land()
        self.assertEqual(self.result(normal)["status"], "landed")
        self.assertEqual(self.result(deferred)["status"], "landed")
        self.assertNotEqual(self.remote_head(), before)
        [receipt] = self.receipts()
        self.assertTrue(receipt["passed"])
        ran = [(c["command"], c["owners"], c["exit_code"], c["stdout_matches"]) for c in receipt["checks"]]
        self.assertEqual(ran, [("true", ["train"], 0, True),
                               ("test -f code.txt", ["t1", "t2"], 0, True),
                               ("bash ./t.sh", ["t2"], 0, True),
                               (structured, ["t2"], 0, True),
                               ("test -f a.txt", ["t2"], 0, True)])
        self.assertTrue(all(c["receipt_verified"] for c in receipt["candidates"]))

    def test_candidate_check_failing_on_integrated_tree_fails_the_train(self):
        self.lane("t1", {"a.txt": "a\n"}, deferred=True, ticket_checks=[], coder_checks=["test ! -e b.txt"])
        self.lane("t2", {"b.txt": "b\n"})
        self.land()
        first = self.receipts()[0]
        self.assertFalse(first["passed"])
        self.assertEqual(first["failed_command"], "test ! -e b.txt")
        self.assertEqual(len(first["candidates"]), 2)

    def queue_at(self, artifacts, stamp):
        request = self.request(artifacts)
        request["queued_at"] = stamp
        (artifacts / "train-request.json").write_text(json.dumps(request))

    def test_split_carries_landed_check_obligations_to_later_subsets(self):
        # Reviewer reproduction: a (queued first) requires b.txt absent; b adds b.txt.
        a = self.lane("a", {"a.txt": "a\n"}, deferred=True, ticket_checks=[], coder_checks=["test ! -e b.txt"])
        b = self.lane("b", {"b.txt": "b\n"})
        self.queue_at(a, "2026-01-01T00:00:00Z")
        self.queue_at(b, "2026-01-01T00:00:01Z")
        self.land()
        self.assertEqual(self.result(a)["status"], "landed")
        result_b = self.result(b)
        self.assertEqual(result_b["status"], "gate_failed")
        self.assertIn("test ! -e b.txt", result_b["detail"])
        self.assertIn("carried from landed a", result_b["detail"])
        # The target keeps a's known check satisfied: b.txt never landed.
        self.assertEqual(git(self.origin, "ls-tree", "--name-only", self.remote_head()).split().count("b.txt"), 0)
        receipts = {(r["candidates"][0]["ticket"], len(r["candidates"])): r for r in self.receipts()}
        self.assertFalse(receipts[("a", 2)]["passed"])
        self.assertTrue(receipts[("a", 1)]["passed"])
        alone_b = receipts[("b", 1)]
        self.assertFalse(alone_b["passed"])
        self.assertEqual(alone_b["carried"], [{"command": "test -f code.txt", "owner": "a", "landed": True},
                                              {"command": "test ! -e b.txt", "owner": "a", "landed": True}])
        self.assertIn({"command": "test ! -e b.txt", "owners": ["a (carried)"]}, alone_b["plan"])
        gate_log = Path(alone_b["gate_log"]).read_text()
        self.assertIn("test ! -e b.txt", gate_log)

    def test_split_obligations_survive_a_restart(self):
        # Reviewer reproduction: a lands from the failed pair, b's prepare raises once, the lander restarts.
        a = self.lane("a", {"a.txt": "a\n"}, deferred=True, ticket_checks=[], coder_checks=["test ! -e b.txt"])
        b = self.lane("b", {"b.txt": "b\n"})
        self.queue_at(a, "2026-01-01T00:00:00Z")
        self.queue_at(b, "2026-01-01T00:00:01Z")
        real_prepare, calls = train.prepare, []

        def flaky_prepare(box, config, repo, logfile):
            calls.append(1)
            if len(calls) == 3:  # combined train, a alone, then b alone: fail once
                raise RuntimeError("integration setup failed (fixture)")
            return real_prepare(box, config, repo, logfile)
        config = self.write_config()
        with mock.patch.object(train, "prepare", flaky_prepare):
            with self.assertRaisesRegex(RuntimeError, "fixture"):
                train.land_queue(config, train.queued(config), str(self.train_dir))
        self.assertEqual(self.result(a)["status"], "landed")
        self.assertIsNone(self.result(b))
        # Restart: a new train directory; a has a result and is no longer queued.
        restart = self.train_dir.parent / "train-2"
        restart.mkdir()
        config = self.write_config()
        self.assertEqual([r["ticket"] for r in train.queued(config)], ["b"])
        train.land_queue(config, train.queued(config), str(restart))
        result_b = self.result(b)
        self.assertEqual(result_b["status"], "gate_failed")
        self.assertIn("test ! -e b.txt", result_b["detail"])
        self.assertEqual(git(self.origin, "ls-tree", "--name-only", self.remote_head()).split().count("b.txt"), 0)
        [receipt] = [json.loads(p.read_text()) for p in restart.glob("receipt-*.json")]
        self.assertIn({"command": "test ! -e b.txt", "owner": "a", "landed": True}, receipt["carried"])
        self.assertEqual(len(receipt["failed_batches"]), 1)
        # Both members resolved: the record is closed and binds nothing any more.
        [record] = [json.loads(p.read_text()) for p in self.train_dir.glob("failed-batch-*.json")]
        self.assertEqual(record["status"], "closed")
        self.assertEqual(record["results"], {"a": "landed", "b": "gate_failed"})
        self.assertEqual(train.open_batches(config), [])

    def test_unreadable_failed_batch_record_stops_the_train(self):
        artifacts = self.lane("a", {"a.txt": "a\n"})
        (self.root / "state/crew-dispatchers/fixture/train/old").mkdir()
        (self.root / "state/crew-dispatchers/fixture/train/old/failed-batch-0-x.json").write_text("{broken")
        with self.assertRaisesRegex(RuntimeError, "unreadable failed-batch record"):
            self.land()
        self.assertIsNone(self.result(artifacts))

    def test_carried_obligations_only_come_from_landed_candidates(self):
        # Neither member lands from the failed pair: nothing is carried into the second half.
        self.config["train"]["gateCommands"] = ["test ! -e a.txt || test ! -e b.txt"]
        a = self.lane("a", {"a.txt": "a\n", "code.txt": "a-change\n"}, coder_checks=None)
        b = self.lane("b", {"b.txt": "b\n"})
        self.queue_at(a, "2026-01-01T00:00:00Z")
        self.queue_at(b, "2026-01-01T00:00:01Z")
        self.land()
        self.assertEqual(self.result(a)["status"], "landed")
        self.assertEqual(self.result(b)["status"], "gate_failed")
        for receipt in self.receipts():
            if receipt["candidates"][0]["ticket"] == "a":
                self.assertEqual(receipt["carried"], [])

    def test_tampered_receipt_digest_is_refused(self):
        artifacts = self.lane("t1", {"a.txt": "a\n"})
        request = self.request(artifacts)
        receipt = Path(request["gate_receipt"])
        data = json.loads(receipt.read_text())
        data["passed"] = True
        data["commands"] = ["true"]
        receipt.write_text(json.dumps(data))
        before = self.remote_head()
        self.land()
        result = self.result(artifacts)
        self.assertEqual(result["status"], "receipt_refused")
        self.assertIn("digest", result["detail"])
        self.assertEqual(self.remote_head(), before)
        self.assertTrue((self.source / ".worktrees/t1/.git").is_dir())
        self.assertIn("-s blocked", self.calls.read_text())
        self.assertNotIn("to-test", self.calls.read_text())

    def test_receipt_tree_differing_from_request_is_refused(self):
        artifacts = self.lane("t1", {"a.txt": "a\n"})
        request = self.request(artifacts)
        request["tree"] = git(self.repo, "rev-parse", "HEAD^{tree}")
        (artifacts / "train-request.json").write_text(json.dumps(request))
        before = self.remote_head()
        self.land()
        result = self.result(artifacts)
        self.assertEqual(result["status"], "receipt_refused")
        self.assertIn("tree", result["detail"])
        self.assertEqual(self.remote_head(), before)
        self.assertTrue((self.source / ".worktrees/t1/.git").is_dir())

    def test_missing_digest_or_moved_checkout_is_refused(self):
        artifacts = self.lane("t1", {"a.txt": "a\n"})
        request = self.request(artifacts)
        del request["gate_receipt_sha256"]
        (artifacts / "train-request.json").write_text(json.dumps(request))
        self.land()
        self.assertEqual(self.result(artifacts)["status"], "receipt_refused")
        other = self.lane("t2", {"b.txt": "b\n"})
        wt = self.source / ".worktrees/t2"
        (wt / "b.txt").write_text("changed after queueing\n")
        git(wt, "commit", "-qam", "later")
        self.land()
        self.assertEqual(self.result(other)["status"], "receipt_refused")
        self.assertIn("changed after it was queued", self.result(other)["detail"])

    def test_deferred_plan_missing_ticket_checks_is_detected(self):
        # The lane recorded its plan before the ticket checks were known; the train rebuilds the plan.
        artifacts = self.lane("t1", {"a.txt": "a\n"}, deferred=True, ticket_checks=[])
        (artifacts / "ticket-checks.json").write_text(json.dumps([{"ac": "AC1", "argv": ["test", "-f", "a.txt"]}]))
        before = self.remote_head()
        self.land()
        result = self.result(artifacts)
        self.assertEqual(result["status"], "receipt_refused")
        self.assertIn("required plan", result["detail"])
        self.assertEqual(self.remote_head(), before)

    def test_gate_that_edits_a_tracked_file_fails_the_train(self):
        self.config["train"]["gateCommands"] = ["echo edited > code.txt"]
        artifacts = self.lane("t1", {"a.txt": "a\n"})
        before = self.remote_head()
        self.land()
        self.assertEqual(self.result(artifacts)["status"], "gate_failed")
        self.assertIn("changed the integrated candidate", self.result(artifacts)["detail"])
        self.assertEqual(self.remote_head(), before)
        self.assertFalse(self.receipts()[0]["passed"])


class RepositoryTests(TrainFixture):
    """Item 4: the request names its repository; batches are single-repository."""

    def second_repository(self):
        origin, repo = self.root / "origin2.git", self.source / "repo2"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True, env=GIT_ENV)
        git(repo, "init", "-q", "-b", "main")
        (repo / ".ntkrc").write_text('{"target_branch":"main"}\n')
        (repo / "code.txt").write_text("other base\n")
        git(repo, "add", ".")
        git(repo, "commit", "-qm", "base")
        git(repo, "remote", "add", "origin", str(origin))
        git(repo, "push", "-q", "origin", "main")
        return repo, origin

    def test_queue_is_split_by_repository_and_each_lands_on_its_own_target(self):
        repo2, origin2 = self.second_repository()
        first = self.lane("t1", {"a.txt": "a\n"})
        second = self.lane("t2", {"b.txt": "b\n"}, repo=repo2)
        self.assertEqual(self.request(second)["repository"], "repo2")
        before1 = self.remote_head()
        before2 = git(repo2, "ls-remote", str(origin2), "refs/heads/main").split()[0]
        self.land()
        self.assertEqual(self.result(first)["status"], "landed")
        self.assertEqual(self.result(second)["status"], "landed")
        self.assertNotEqual(self.remote_head(), before1)
        after2 = git(repo2, "ls-remote", str(origin2), "refs/heads/main").split()[0]
        self.assertNotEqual(after2, before2)
        receipts = self.receipts()
        self.assertEqual(sorted(len(r["candidates"]) for r in receipts), [1, 1])
        self.assertEqual(sorted(r["target"] for r in receipts), ["develop", "main"])

    def test_mixed_batch_is_rejected_and_bad_repository_is_refused(self):
        repo2, _ = self.second_repository()
        first = self.lane("t1", {"a.txt": "a\n"})
        second = self.lane("t2", {"b.txt": "b\n"}, repo=repo2)
        config = self.write_config()
        with self.assertRaisesRegex(RuntimeError, "one repository"):
            train.land(config, train.queued(config), str(self.train_dir))
        for bad in ("", "../repo", ".worktrees/t1", "missing", "repo2"):
            with self.subTest(repository=bad):
                request = self.request(first)
                request["repository"] = bad
                (first / "train-request.json").write_text(json.dumps(request))
                with self.assertRaises(ValueError):
                    train.check_receipt(config, next(r for r in train.queued(config) if r["ticket"] == "t1"))


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
