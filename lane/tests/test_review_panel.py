"""Run the actual panel synthesis with contradictory and incomplete reviews."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_failure_outcome import shell_body


class ReviewPanelTests(unittest.TestCase):
    def panel(self, report="## FINDINGS\nNONE\nCOVERAGE: assigned behavior and checks\n",
              seats=("architecture", "codereview", "security"), missing=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / "artifacts"
            artifacts.mkdir()
            rows = []
            (root / "inputs.json").write_text(json.dumps([{"slug": seat} for seat in seats]))
            for seat in seats:
                rows.append({"slug": seat, "harness": seat, "ok": True, "rc": 0,
                             "signals": [{"name": "CLEAR"}]})
                body = report if seat == seats[0] else "NONE\nCOVERAGE: assigned behavior\n"
                if body is not None:
                    (artifacts / f"{seat}.md").write_text(body)
            manifest = root / "manifest.jsonl"
            if missing:
                rows.pop()
            manifest.write_text("".join(json.dumps(row) + "\n" for row in rows))
            result = subprocess.run(["bash", "-c", shell_body("expert_review_synthesis")],
                env={**os.environ, "MEDULLA_RUN_DIR": str(root),
                     "MEDULLA_MANIFEST_EXPERT_REVIEW": str(manifest)},
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout, (artifacts / "panel-findings.txt").read_text()

    def test_clear_signal_cannot_hide_a_high_finding(self):
        for label in ("- HIGH", "  - **HIGH**", "* __HIGH__"):
            with self.subTest(label=label):
                output, history = self.panel(f"## FINDINGS\n{label} - Missing authorization - src/api.rs:2 - exposure - FIX: check access\nCOVERAGE: assigned behavior\n")
                self.assertIn("<signal:REJECT>", output)
                self.assertNotIn("<signal:CLEAR>", output)
                self.assertIn("Missing authorization", history)

    def test_missing_report_or_coverage_cannot_clear(self):
        for report in (None, "NONE\n", "NONE\nCOVERAGE:   \n"):
            with self.subTest(report=report):
                output, _ = self.panel(report)
                self.assertIn("<signal:REVIEW_INCOMPLETE>", output)

    def test_nonblocking_findings_do_not_reject_a_complete_panel(self):
        output, _ = self.panel("## FINDINGS\n- MED - Optional improvement\nCOVERAGE: assigned behavior\n")
        self.assertIn("<signal:CLEAR>", output)

    def test_reviewers_come_from_workflow_configuration(self):
        for seats in (("quality",), ("correctness", "simplicity")):
            with self.subTest(seats=seats):
                output, _ = self.panel(seats=seats)
                self.assertIn("<signal:CLEAR>", output)
                output, _ = self.panel(seats=seats, missing=True)
                self.assertIn("<signal:REVIEW_INCOMPLETE>", output)

    @unittest.skipUnless(shutil.which("medulla"), "Medulla executable is unavailable")
    def test_real_engine_provides_the_configured_pool_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = {"version": "2", "start": "expert_review", "timeout": 30,
                "nodes": {
                    "expert_review": {"inputs": [{"slug": "quality"}, {"slug": "correctness"}],
                        "max_parallel": 2,
                        "shell": 'mkdir -p "$MEDULLA_RUN_DIR/artifacts"\n'
                                 'printf "NONE\\nCOVERAGE: assigned behavior\\n" > "$MEDULLA_RUN_DIR/artifacts/$MEDULLA_INPUT_SLUG.md"\n'
                                 'echo "<signal:CLEAR>checked</signal:CLEAR>"',
                        "on_signal": {"__done__": "expert_review_synthesis", "__failed__": "__exit_fail__"}},
                    "expert_review_synthesis": {"shell": shell_body("expert_review_synthesis"),
                        "on_signal": {"CLEAR": "__exit_ok__", "REJECT": "__exit_fail__",
                                      "REVIEW_INCOMPLETE": "__exit_fail__", "__failed__": "__exit_fail__"}}}}
            (root / "workflow.yaml").write_text(json.dumps(workflow))
            result = subprocess.run([shutil.which("medulla"), "-w", str(root),
                "--runs-folder", str(root / "runs")], cwd=root,
                capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifests = list((root / "runs").glob("*/steps/*expert_review/manifest.jsonl"))
            self.assertEqual(len(manifests), 1)
            inputs = json.loads((manifests[0].parent / "inputs.json").read_text())
            self.assertEqual([item["slug"] for item in inputs], ["quality", "correctness"])


if __name__ == "__main__":
    unittest.main()
