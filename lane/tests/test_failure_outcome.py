"""Exercise the real failure node with local stand-ins for external services."""

import os
import json
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / "workflow.yaml"


def shell_body(node):
    lines = WORKFLOW.read_text().splitlines()
    start = lines.index(f"  {node}:") + 1
    for index in range(start, len(lines)):
        if lines[index] == "    shell: |":
            start = index + 1
            break
        if lines[index] and not lines[index].startswith("    "):
            raise AssertionError(f"No shell body for {node}")
    else:
        raise AssertionError(f"No shell body for {node}")
    end = start
    while end < len(lines) and (not lines[end] or lines[end].startswith("      ")):
        end += 1
    return textwrap.dedent("\n".join(lines[start:end])) + "\n"


class FailureOutcomeTests(unittest.TestCase):
    def run_failure(self, signal, *, update_fails=False, inherited_want=None, claimed=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = root / "lane-launcher"
            commands.mkdir()
            scripts = {
                "node": '#!/bin/bash\nprintf "%s\\n" "${2}" >> "$TEST_STATUS_LOG"\n'
                       'if [ "$TEST_UPDATE_FAILS" = 1 ]; then\n'
                       '  echo "status service unavailable" >&2\n  exit 1\nfi\n',
            }
            for name, script in scripts.items():
                path = commands / name
                path.write_text(script)
                path.chmod(0o755)
            env = dict(os.environ)
            env.pop("MEDULLA_LAST_SIGNAL", None)
            env.pop("want", None)
            env.update({
                "PATH": f"{commands}:/usr/bin:/bin",
                "TOOLING_ROOT": str(root),
                "MEDULLA_RUN_DIR": str(root / "run"),
                "LANE_WORKTREE": str(root / "worktree"),
                "MEDULLA_LAST_NODE": "implement_code",
                "MEDULLA_LAST_MESSAGE": "candidate checks did not complete",
                "ticket_id": "fixture-task",
                "project_name": "fixture-project",
                "project_dir": str(root),
                "TEST_STATUS_LOG": str(root / "status.log"),
                "TEST_UPDATE_FAILS": "1" if update_fails else "0",
            })
            if signal is not None:
                env["MEDULLA_LAST_SIGNAL"] = signal
            if inherited_want is not None:
                env["want"] = inherited_want
            if claimed:
                artifacts = root / 'run/artifacts'
                artifacts.mkdir(parents=True)
                (artifacts / 'claim.json').write_text(json.dumps({
                    'id': 'fixture-task', 'workspace': 'fixture-project',
                    'run_dir': str(root / 'run'), 'claimed': True, 'status': 'in_progress',
                }))
            result = subprocess.run(
                ["bash", "-c", shell_body("notify_failure")],
                env=env, cwd=root, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 1 if signal == 'CLAIM_REFUSED' or not claimed else 0, result.stderr)
            log = root / "status.log"
            updates = log.read_text().splitlines() if log.exists() else []
            report = (root / "run/artifacts/failure.txt").read_text()
            return updates, report

    def test_failed_or_unknown_outcome_never_reopens_work(self):
        for signal in (
            "BRANCH_HAS_WORK", "DUPLICATE", "PREMISE_BROKEN", "OUT_OF_MODULE",
            "LAND_FAILED", "TOO_MANY_ROUNDS", "GATE_FAIL", "FETCH_FAILED",
            "NO_GIT_KEY", "NOTHING_DONE", "UNRECOGNIZED_SIGNAL", "", None,
        ):
            with self.subTest(signal=signal):
                updates, report = self.run_failure(signal)
                self.assertEqual(updates, [
                    "blocked"
                ])
                self.assertIn("candidate checks did not complete", report)

    def test_refused_claim_does_not_change_someone_elses_work(self):
        for inherited_want in (None, "open", "blocked"):
            with self.subTest(inherited_want=inherited_want):
                updates, _ = self.run_failure(
                    "CLAIM_REFUSED", inherited_want=inherited_want,
                )
                self.assertEqual(updates, [])

    def test_failed_status_write_is_preserved_in_durable_report(self):
        updates, report = self.run_failure("GATE_FAIL", update_fails=True)
        self.assertEqual(len(updates), 1)
        self.assertIn("status service unavailable", report)
        self.assertIn("NTK outcome incomplete", report)

    def test_failure_before_claim_never_writes_ticket(self):
        updates, report = self.run_failure('__failed__', claimed=False)
        self.assertEqual(updates, [])
        self.assertIn('No confirmed claim', report)


if __name__ == "__main__":
    unittest.main()
