"""Run claim and cleanup shell bodies with isolated command stand-ins."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import unittest
from test_failure_outcome import shell_body


class ClaimCleanupTests(unittest.TestCase):
    def test_claim_receipt_requires_a_confirmed_response(self):
        cases = [
            ({"id":"T1", "status":"in_progress", "claimed":True, "workspace":"test"}, "fixture contract", True),
            ({"id":"t1", "status":"in_progress", "claimed":True, "workspace":"test"}, "fixture contract", True),
            ({"id":"T1", "status":"in_progress", "claimed":True, "workspace":"test"}, "", True),
            ({"id":"T1", "status":"open", "claimed":False, "workspace":"test"}, "fixture contract", False),
            ({"id":"OTHER", "status":"in_progress", "claimed":True, "workspace":"test"}, "fixture contract", False),
            ({"id":"T1", "status":"in_progress", "claimed":True, "workspace":"other"}, "fixture contract", False),
            (None, "fixture contract", False),
        ]
        for response, contract, adopted in cases:
            with self.subTest(response=response, contract=contract), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                for folder in ("lane/hooks", "lane/bin", "lane-launcher", "bin"):
                    (root / folder).mkdir(parents=True, exist_ok=True)
                (root / "lane/hooks/inject.sh").write_text('printf \'{"permissions":{"deny":[]}}\' > "$1"\n')
                (root / "lane/hooks/codex-home.sh").write_text("exit 0\n")
                (root / "lane-launcher/ntk.mjs").write_text(
                    'export async function getTicket(id) { return {id, body: "fixture acceptance"}; }\n')
                helper = Path(__file__).resolve().parents[1] / "bin/ticket-input.mjs"
                (root / "lane/bin/ticket-input.mjs").write_text(helper.read_text())
                equill = root / "bin/equill"
                equill.write_text('#!/bin/sh\nprintf "%s" "$CONTRACT_RESPONSE"\n')
                equill.chmod(0o755)
                claim_file = root / "host-claim.json"
                if response is not None:
                    claim_file.write_text(json.dumps(response))
                env = dict(os.environ, TOOLING_ROOT=d, project_dir=d, ticket_id="T1", project_name="test",
                           MEDULLA_RUN_DIR=str(root / "run"), LAUNCH_CLAIM_FILE=str(claim_file),
                           CONTRACT_RESPONSE=json.dumps({"content": contract}),
                           PATH=str(root / "bin") + os.pathsep + os.environ["PATH"])
                body = shell_body("prepare").replace("/tmp/", d + "/")
                result = subprocess.run(["bash", "-c", body], env=env, capture_output=True, text=True)
                receipt = root / "run/artifacts/claim.json"
                if adopted:
                    self.assertEqual(result.returncode, 0 if contract else 1, result.stderr)
                    self.assertIn(f'<signal:var key=RUN_ARTIFACTS>{root}/run/artifacts</signal:var>', result.stdout)
                    claim = json.loads(receipt.read_text())
                    self.assertEqual(claim["workspace"], "test")
                    self.assertEqual(claim["run_dir"], str(root / "run"))
                    if contract:
                        self.assertIn("<signal:READY>", result.stdout)
                        ticket = json.loads((root / "run/artifacts/ticket.json").read_text())
                        self.assertEqual(ticket["body"], "fixture acceptance")
                    else:
                        self.assertIn("Scout contract unavailable", result.stderr)
                        self.assertFalse((root / "run/artifacts/scout-contract.txt").exists())
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(receipt.exists())
                    self.assertFalse((root / "run/artifacts/ticket.json").exists())

    def test_cleanup_preserves_landing_and_fails_when_to_test_fails(self):
        for rc in (0, 1):
            with self.subTest(rc=rc), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                bins = root / 'bin'
                bins.mkdir()
                (root / 'lane/bin').mkdir(parents=True)
                shutil.copy(Path(__file__).resolve().parents[1] / 'bin/target.sh', root / 'lane/bin/target.sh')
                for name, script in {
                    'git': '#!/bin/sh\nif [ "$3" = rev-parse ]; then echo abcdef123456; fi\n',
                    'jq': '#!/bin/sh\necho develop\n',
                    'node': '#!/bin/sh\nexit "$RESULT_RC"\n',
                }.items():
                    file = bins / name
                    file.write_text(script)
                    file.chmod(0o755)
                env = dict(os.environ, PATH=str(bins) + os.pathsep + os.environ['PATH'],
                           TOOLING_ROOT=d, project_dir=d, ticket_id='T1', project_name='test',
                           MEDULLA_RUN_DIR=str(root / 'run'), LANE_WORKTREE=str(root / 'wt'), RESULT_RC=str(rc))
                result = subprocess.run(['bash', '-c', shell_body('cleanup')], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, rc, result.stderr)
                self.assertIn('Landed SHA: abcdef123456', (root / 'run/artifacts/landing.txt').read_text())
                if rc:
                    self.assertNotIn('<signal:LANDED>', result.stdout)
                    self.assertIn('Do not rerun work', (root / 'run/artifacts/outcome.txt').read_text())
                else:
                    self.assertIn('<signal:LANDED>', result.stdout)
