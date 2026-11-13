"""Run claim and cleanup shell bodies with isolated command stand-ins."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import shutil
import unittest
from test_failure_outcome import shell_body

TOKEN = "jpr_" + "a" * 64


class _DataHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        if self.path != "/api/data" or self.headers.get("Authorization") != f"Bearer {TOKEN}":
            status, payload = 401, b'{"error":"unauthorized"}'
        else:
            body = self.server.contract_body
            items = [{"address": "spec:scout", "kind": "spec", "revision": 1,
                      "title": "Scout", "body": body}] if body else []
            status, payload = 200, json.dumps({"workspace": "test", "position": 1, "items": items}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ClaimCleanupTests(unittest.TestCase):
    def test_claim_receipt_requires_a_confirmed_response(self):
        task = {"source": "joppa", "ticket": {"id": "T1", "body": "fixture acceptance"}}
        cases = [
            ({"id":"T1", "status":"in_progress", "claimed":True, "workspace":"test", **task}, "fixture contract", True),
            ({"id":"t1", "status":"in_progress", "claimed":True, "workspace":"test", **task}, "fixture contract", True),
            ({"id":"T1", "status":"in_progress", "claimed":True, "workspace":"test", **task}, "", True),
            ({"id":"T1", "status":"open", "claimed":False, "workspace":"test", **task}, "fixture contract", False),
            ({"id":"OTHER", "status":"in_progress", "claimed":True, "workspace":"test", **task}, "fixture contract", False),
            ({"id":"T1", "status":"in_progress", "claimed":True, "workspace":"other", **task}, "fixture contract", False),
            (None, "fixture contract", False),
        ]
        lane_dir = Path(__file__).resolve().parents[1]
        server = HTTPServer(("127.0.0.1", 0), _DataHandler)
        server.contract_body = ""
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        for response, contract, adopted in cases:
            with self.subTest(response=response, contract=contract), tempfile.TemporaryDirectory() as d:
                server.contract_body = contract
                root = Path(d)
                for folder in ("lane/hooks", "lane/bin", "lane-launcher", "bin"):
                    (root / folder).mkdir(parents=True, exist_ok=True)
                (root / "lane/hooks/inject.sh").write_text('printf \'{"permissions":{"deny":[]}}\' > "$1"\n')
                (root / "lane/hooks/codex-home.sh").write_text("exit 0\n")
                for hook_file in ("memory-hook.sh", "joppa-data.sh"):
                    shutil.copy(lane_dir / "hooks" / hook_file, root / "lane/hooks" / hook_file)
                helper = lane_dir / "bin/ticket-input.mjs"
                (root / "lane/bin/ticket-input.mjs").write_text(helper.read_text())
                token_file = root / "context-token"
                token_file.write_text(TOKEN + "\n")
                token_file.chmod(0o600)
                memory_config = root / "context-config.json"
                memory_config.write_text(json.dumps({
                    "url": f"http://127.0.0.1:{server.server_port}/api/data",
                    "workspace": "test",
                    "root": "req:r",
                    "token_file": str(token_file),
                    "filter_env": {"role": "LANE_MEMORY_ROLE", "project": "LANE_MEMORY_PROJECT"},
                    "session": {"kind": ["spec"], "fields": ["title", "body"]},
                    "stop": {"kind": "spec", "field": "ends_when"},
                }))
                claim_file = root / "host-claim.json"
                if response is not None:
                    claim_file.write_text(json.dumps(response))
                env = dict(os.environ, TOOLING_ROOT=d, project_dir=d, ticket_id="T1", project_name="test",
                           MEDULLA_RUN_DIR=str(root / "run"), LAUNCH_CLAIM_FILE=str(claim_file),
                           LANE_MEMORY_CONFIG=str(memory_config), LANE_MEMORY_ROLE="scout-role",
                           LANE_MEMORY_PROCESS="scout-role", LANE_MEMORY_PROJECT="test",
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
                        self.assertIn(contract, (root / "run/artifacts/scout-contract.txt").read_text())
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
                env = dict(os.environ, PATH=str(bins) + os.pathsep + os.environ['PATH'], TARGET_BRANCH='develop',
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
