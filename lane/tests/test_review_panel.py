"""Run the actual panel synthesis with contradictory and incomplete reviews."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_failure_outcome import shell_body


class ReviewPanelTests(unittest.TestCase):
    def panel(self, report="## FINDINGS\nNONE\nCOVERAGE: assigned behavior and checks\n"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / "artifacts"
            artifacts.mkdir()
            rows = []
            for seat in ("architecture", "codereview", "security"):
                rows.append({"slug": seat, "harness": seat, "ok": True, "rc": 0,
                             "signals": [{"name": "CLEAR"}]})
                body = report if seat == "architecture" else "NONE\nCOVERAGE: assigned behavior\n"
                if body is not None:
                    (artifacts / f"{seat}.md").write_text(body)
            manifest = root / "manifest.jsonl"
            manifest.write_text("".join(json.dumps(row) + "\n" for row in rows))
            result = subprocess.run(["bash", "-c", shell_body("expert_review_synthesis")],
                env={**os.environ, "MEDULLA_RUN_DIR": str(root),
                     "MEDULLA_MANIFEST_EXPERT_REVIEW": str(manifest)},
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout, (artifacts / "panel-findings.txt").read_text()

    def test_clear_signal_cannot_hide_a_high_finding(self):
        output, history = self.panel("## FINDINGS\n- HIGH - Missing authorization - src/api.rs:2 - exposure - FIX: check access\nCOVERAGE: assigned behavior\n")
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


if __name__ == "__main__":
    unittest.main()
