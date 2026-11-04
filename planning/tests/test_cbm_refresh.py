import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

PLANNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLANNING))
import stages
import tools

# A fake CBM CLI: records argv, answers from a JSON plan, and can edit a source during indexing.
FAKE_CBM = r'''#!/usr/bin/env python3
import fcntl, json, os, sys
plan = json.load(open(os.environ["FAKE_CBM_PLAN"]))
with open(os.environ["FAKE_CBM_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
tool, args = sys.argv[3], sys.argv[4:]
flags = dict(zip(args[::2], args[1::2]))
# Every CBM call must run while the planner holds the canonical sync lock.
with open(os.path.join(flags.get("--repo-path") or plan["roots"][flags["--project"]], ".git/sync.lock"), "a") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps({"isError": True, "content": [{"type": "text", "text": "sync lock not held"}]}))
        sys.exit(0)
    except BlockingIOError:
        pass
if tool == "index_repository":
    name = flags["--name"]
    if plan.get("touch") == name:
        open(os.path.join(flags["--repo-path"], "moved.txt"), "w").write("moved\n")
    if plan.get("index_error") == name:
        print(json.dumps({"isError": True, "content": [{"type": "text", "text": "index failed: disk full"}]}))
        sys.exit(0)
    project = plan.get("index_project", {}).get(name, name)
    text = json.dumps({"project": project, "excluded": {}, "not_indexed_files_count": 5})
else:
    name = flags["--project"]
    if plan.get("status_missing") == name:
        text = json.dumps({"error": "project not found or not indexed",
                           "hint": "Use list_projects to see indexed projects", "available_projects": []})
        print(json.dumps({"content": [{"type": "text", "text": text}]}))
        sys.exit(0)
    status = {"project": name, "nodes": 1775, "edges": 8189, "status": plan.get("status", {}).get(name, "ready"),
              "root_path": plan.get("root", {}).get(name, plan["roots"][name]),
              "indexed_at": "2026-11-04T09:39:02Z", "parse_partial": {"files": 0}}
    print(json.dumps({"content": [{"type": "text", "text": json.dumps(status)}], "structuredContent": status}))
    sys.exit(0)
print(json.dumps({"content": [{"type": "text", "text": text}]}))
'''

# Holds the sync lock in another process, like a lane in startup sync.
HOLDER = """import fcntl, sys, time
lock = open(sys.argv[1], "a")
fcntl.flock(lock, fcntl.LOCK_EX)
print("held", flush=True)
time.sleep(float(sys.argv[2]))
"""


class RefreshIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crew-cbm-refresh-")
        base = Path(self.temp.name)
        self.repos = []
        for key in ("alpha", "beta"):
            repo = base / key
            repo.mkdir()
            (repo / "main.py").write_text("value = 1\n")
            for args in (["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                                          "commit", "-qm", "base"]):
                subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
            self.repos.append({"id": key, "path": str(repo), "cbm_project": f"{key}-project"})
        self.rows = [{"name": r["cbm_project"], "root_path": os.path.realpath(r["path"]), "branch": "main"}
                     for r in self.repos]
        binary = base / "cbm"
        binary.write_text(FAKE_CBM)
        binary.chmod(0o755)
        self.log, self.plan_file = base / "calls.log", base / "plan.json"
        self.plan = {"roots": {r["cbm_project"]: os.path.realpath(r["path"]) for r in self.repos}}
        self.env = patch.dict(os.environ, {"CBM_BIN": str(binary), "FAKE_CBM_LOG": str(self.log),
                                           "FAKE_CBM_PLAN": str(self.plan_file)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def refresh(self, **plan):
        self.plan_file.write_text(json.dumps({**self.plan, **plan}))
        return tools.refresh_index(self.repos, self.rows)

    def refused(self, message, **plan):
        with self.assertRaisesRegex(ValueError, message):
            self.refresh(**plan)
        self.assert_locks_free()

    def assert_locks_free(self):
        for repo in self.repos:
            with open(Path(repo["path"]) / ".git/sync.lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_UN)

    def hold_lock(self, repo, seconds):
        child = subprocess.Popen([sys.executable, "-c", HOLDER, str(Path(repo["path"]) / ".git/sync.lock"), str(seconds)],
                                 stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        self.assertEqual(child.stdout.readline().strip(), "held")
        return child

    def test_a_busy_sync_lock_waits_then_refuses_when_the_budget_ends(self):
        self.hold_lock(self.repos[1], 30)
        started = time.monotonic()
        with patch.object(tools, "REFRESH_SECONDS", 1):
            self.plan_file.write_text(json.dumps(self.plan))
            with self.assertRaisesRegex(ValueError, "beta: canonical sync lock stayed busy for the whole 1 s"):
                tools.refresh_index(self.repos, self.rows)
        self.assertGreaterEqual(time.monotonic() - started, 0.9)
        self.assertEqual([call[2] for call in self.calls()], ["index_repository", "index_status"])
        with open(Path(self.repos[0]["path"]) / ".git/sync.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertTrue((Path(self.repos[1]["path"]) / ".git/sync.lock").exists())

    def test_the_refresh_continues_after_the_sync_owner_releases(self):
        self.hold_lock(self.repos[0], 0.5)
        started = time.monotonic()
        self.assertEqual(set(self.refresh()), {"alpha", "beta"})
        self.assertGreaterEqual(time.monotonic() - started, 0.4)
        self.assert_locks_free()

    def test_an_unexpected_error_releases_the_lock(self):
        self.plan_file.write_text(json.dumps(self.plan))
        with patch.object(tools, "fingerprint", side_effect=RuntimeError("git broke")):
            with self.assertRaisesRegex(RuntimeError, "git broke"):
                tools.refresh_index(self.repos, self.rows)
        self.assert_locks_free()

    def test_happy_path_indexes_each_repository_under_its_lock_and_records_its_snapshot(self):
        with tempfile.TemporaryDirectory() as run_dir, \
                patch.dict(os.environ, {"MEDULLA_RUN_DIR": run_dir}), \
                patch.object(stages, "ThreadPoolExecutor", side_effect=RuntimeError("stop after CBM")):
            self.plan_file.write_text(json.dumps(self.plan))
            with self.assertRaisesRegex(RuntimeError, "stop after CBM"):
                stages.prepare_context({"repositories": self.repos}, projects=self.rows)
            snapshots = json.loads((Path(run_dir) / "artifacts/snapshots.json").read_text())
        self.assertEqual(snapshots, {r["id"]: stages.fingerprint(r) for r in self.repos})
        expected = []
        for repo in self.repos:
            root, name = os.path.realpath(repo["path"]), repo["cbm_project"]
            expected += [["cli", "--json", "index_repository", "--repo-path", root, "--name", name,
                          "--mode", "moderate", "--persistence", "false"],
                         ["cli", "--json", "index_status", "--project", name, "--format", "json"]]
        self.assertEqual(self.calls(), expected)

    def test_a_later_wrong_binding_refuses_before_any_index_call(self):
        self.rows[1] = {**self.rows[1], "root_path": "/elsewhere"}
        self.refused("beta: CBM project beta-project is not bound to")
        self.rows[1] = {**self.rows[1], "name": "other"}
        self.refused("beta: CBM project beta-project is absent")
        self.assertEqual(self.calls(), [])

    def test_index_status_not_ready_refuses(self):
        self.refused("alpha: CBM project alpha-project is not ready", status={"alpha-project": "indexing"})

    def test_unknown_project_status_refuses_with_the_cbm_error(self):
        self.refused("CBM index_status failed: project not found or not indexed", status_missing="beta-project")

    def test_all_cli_calls_share_one_deadline(self):
        clock, timeouts, real_run = [1000.0], [], tools.run
        def timed_run(argv, timeout=45, **kwargs):
            timeouts.append(timeout)
            clock[0] += 100
            return real_run(argv, timeout=timeout, **kwargs)
        with patch.object(tools.time, "monotonic", lambda: clock[0]), patch.object(tools, "run", timed_run):
            self.refused("beta: CBM refresh used its 240 s budget before index_status")
        self.assertEqual(timeouts, [240, 140, 40])
        self.assertEqual([call[2] for call in self.calls()], ["index_repository", "index_status", "index_repository"])

    def test_a_cli_timeout_refuses_clearly(self):
        def slow(argv, timeout=45, **kwargs):
            raise subprocess.TimeoutExpired(argv, timeout)
        with patch.object(tools, "run", slow):
            self.refused("CBM index_repository did not finish within 240 s")

    def test_index_status_root_mismatch_refuses(self):
        self.refused("beta: CBM project beta-project is not ready", root={"beta-project": "/elsewhere"})

    def test_source_change_during_refresh_refuses(self):
        self.refused("alpha: source changed during the CBM refresh", touch="alpha-project")

    def test_index_error_or_other_project_refuses(self):
        self.refused("CBM index_repository failed: index failed: disk full", index_error="alpha-project")
        self.refused("beta: CBM did not index beta-project: .*other", index_project={"beta-project": "other"})


if __name__ == "__main__":
    unittest.main()
