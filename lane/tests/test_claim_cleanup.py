"""Run claim and cleanup shell bodies with isolated command stand-ins."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_failure_outcome import shell_body


class ClaimCleanupTests(unittest.TestCase):
    def test_claim_receipt_requires_a_confirmed_response(self):
        for response, rc in [('{"id":"T1","status":"in_progress","claimed":true}', 0),
                             ('{"id":"T1","status":"open","claimed":false}', 0),
                             ('{"id":"OTHER","status":"in_progress","claimed":true}', 0),
                             ('', 1)]:
            with self.subTest(response=response, rc=rc), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / 'lane/hooks').mkdir(parents=True)
                (root / 'lane-launcher').mkdir()
                (root / 'bin').mkdir()
                (root / 'lane/hooks/inject.sh').write_text('printf \'{"permissions":{"deny":[]}}\' > "$1"\n')
                (root / 'lane/hooks/codex-home.sh').write_text('exit 0\n')
                (root / 'lane-launcher/ntk-status').write_text('printf "%s" "$RESPONSE"\nexit "$RESPONSE_RC"\n')
                equill = root / 'bin/equill'
                equill.write_text('#!/bin/sh\nprintf \'{"content":"fixture contract"}\'\n')
                equill.chmod(0o755)
                env = dict(os.environ, TOOLING_ROOT=d, project_dir=d, ticket_id='T1', project_name='test',
                           MEDULLA_RUN_DIR=str(root / 'run'), RESPONSE=response, RESPONSE_RC=str(rc),
                           PATH=str(root / 'bin') + os.pathsep + os.environ['PATH'])
                body = shell_body('ntk_claim').replace('/tmp/', d + '/')
                result = subprocess.run(['bash', '-c', body], env=env, capture_output=True, text=True)
                receipt = root / 'run/artifacts/claim.json'
                if response and json.loads(response).get('claimed') and 'OTHER' not in response:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    claim = json.loads(receipt.read_text())
                    self.assertEqual(claim['workspace'], 'test')
                    self.assertEqual(claim['run_dir'], str(root / 'run'))
                else:
                    self.assertFalse(receipt.exists())
                    self.assertTrue(result.returncode != 0 or 'CLAIM_REFUSED' in result.stdout)

    def test_cleanup_preserves_landing_and_fails_when_to_test_fails(self):
        for rc in (0, 1):
            with self.subTest(rc=rc), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                bins = root / 'bin'
                bins.mkdir()
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
                           MEDULLA_RUN_DIR=str(root / 'run'), LANE_WT_ROOT=str(root / 'wt'), RESULT_RC=str(rc))
                result = subprocess.run(['bash', '-c', shell_body('cleanup')], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, rc, result.stderr)
                self.assertIn('Landed SHA: abcdef123456', (root / 'run/artifacts/landing.txt').read_text())
                if rc:
                    self.assertNotIn('<signal:LANDED>', result.stdout)
                    self.assertIn('Do not rerun implementation', (root / 'run/artifacts/outcome.txt').read_text())
                else:
                    self.assertIn('<signal:LANDED>', result.stdout)
