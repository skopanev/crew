"""Lane runs folder configuration checks. No network, credentials, or live mutations."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
import context


class LaneRunsConfigTests(unittest.TestCase):
    def configure(self, **cleanup):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        config = {"workspace": "product", "url": "https://joppa.example/mcp", "token_file": "token",
                  "runs_folder": "runs", "cbm_store": "cbm", "cbm_root": "src", "context": {"token_file": "key", "session": {}, "query": {}, "roles": {"researcher": "r", "designer": "d", "critic": "c"}},
                  "repositories": [{"id": "app", "project": "project:app", "path": str(folder / "src" / "app"),
                                    "cbm_project": "app", "modules": [{"name": "core", "path": "src"}]}],
                  **cleanup}
        (folder / "config.json").write_text(json.dumps(config))
        return context.configuration(folder / "config.json")

    def test_single_lane_runs_folder_stays_valid(self):
        config = self.configure(worktree_root="/work/trees", lane_runs_folder="/state/one/runs")
        self.assertEqual(config["lane_runs_folder"], "/state/one/runs")
        self.assertEqual(context.lane_runs_folders(config), ["/state/one/runs"])

    def test_null_plural_field_stays_null_beside_the_single_field(self):
        config = self.configure(worktree_root="/work/trees", lane_runs_folder="/state/one/runs", lane_runs_folders=None)
        self.assertIsNone(config["lane_runs_folders"])
        self.assertEqual(context.lane_runs_folders(config), ["/state/one/runs"])

    def test_lane_runs_folders_lists_every_dispatcher(self):
        folders = ["/state/one/runs", "/state/two/runs"]
        config = self.configure(worktree_root="/work/trees", lane_runs_folders=folders)
        self.assertEqual(context.lane_runs_folders(config), folders)
        self.assertNotIn("lane_runs_folder", config)

    def test_invalid_lane_runs_folders_are_refused(self):
        cases = {"not both": {"lane_runs_folder": "/state/one/runs", "lane_runs_folders": ["/state/two/runs"]},
                 "nonempty list": {"lane_runs_folders": []},
                 "absolute paths": {"lane_runs_folders": ["state/runs"]},
                 "distinct": {"lane_runs_folders": ["/state/runs", "/state/runs"]},
                 "parent traversal": {"lane_runs_folders": ["/state/../runs"]},
                 "configured together": {"lane_runs_folders": ["/state/runs"], "worktree_root": None}}
        for message, cleanup in cases.items():
            with self.subTest(message):
                with self.assertRaisesRegex(Exception, message):
                    self.configure(**{"worktree_root": "/work/trees", **cleanup})


if __name__ == "__main__":
    unittest.main()
