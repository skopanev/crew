import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PLANNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLANNING))
import stages
import tools

# A fake CBM CLI: records argv, answers from a JSON plan, and can edit a source during indexing.
FAKE_CBM = r'''#!/usr/bin/env python3
import json, os, sys
plan = json.load(open(os.environ["FAKE_CBM_PLAN"]))
with open(os.environ["FAKE_CBM_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
tool, args = sys.argv[3], sys.argv[4:]
flags = dict(zip(args[::2], args[1::2]))
if tool == "index_repository":
    name = flags["--name"]
    if plan.get("touch") == name:
        open(os.path.join(flags["--repo-path"], "moved.txt"), "w").write("moved\n")
    if plan.get("index_error") == name:
        print(json.dumps({"isError": True, "content": [{"type": "text", "text": "failed"}]}))
        sys.exit(0)
    project = plan.get("index_project", {}).get(name, name)
    text = json.dumps({"project": project, "excluded": {}, "not_indexed_files_count": 5})
else:
    name = flags["--project"]
    status = plan.get("status", {}).get(name, "ready")
    root = plan.get("root", {}).get(name, plan["roots"][name])
    text = (f"project: {name}\nnodes: 1775\nedges: 8189\nstatus: {status}\nroot_path: {root}\n"
            "indexed_at: 2026-11-04T09:39:02Z\nparse_partial:\n  files: 0\n  status: partial\n")
print(json.dumps({"content": [{"type": "text", "text": text}]}))
'''


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

    def test_happy_path_indexes_each_repository_in_memory_and_records_its_snapshot(self):
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
            expected += [["cli", "--json", "index_repository", "--repo-path", root, "--name", name, "--persistence", "false"],
                         ["cli", "--json", "index_status", "--project", name]]
        self.assertEqual(self.calls(), expected)

    def test_a_later_wrong_binding_refuses_before_any_index_call(self):
        self.rows[1] = {**self.rows[1], "root_path": "/elsewhere"}
        self.refused("beta: CBM project beta-project is not bound to")
        self.rows[1] = {**self.rows[1], "name": "other"}
        self.refused("beta: CBM project beta-project is absent")
        self.assertEqual(self.calls(), [])

    def test_index_status_not_ready_refuses(self):
        self.refused("alpha: CBM project alpha-project is not ready", status={"alpha-project": "indexing"})

    def test_index_status_root_mismatch_refuses(self):
        self.refused("beta: CBM project beta-project is not ready", root={"beta-project": "/elsewhere"})

    def test_source_change_during_refresh_refuses(self):
        self.refused("alpha: source changed during the CBM refresh", touch="alpha-project")

    def test_index_error_or_other_project_refuses(self):
        self.refused("CBM index_repository failed", index_error="alpha-project")
        self.refused("beta: CBM did not index beta-project: .*other", index_project={"beta-project": "other"})


if __name__ == "__main__":
    unittest.main()
