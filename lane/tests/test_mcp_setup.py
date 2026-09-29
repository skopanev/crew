"""Check MCP configuration and bridge identity without accounts or live services."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import tomllib
import unittest

LANE = Path(__file__).resolve().parents[1]


class McpSetupTests(unittest.TestCase):
    def test_launcher_refuses_an_old_bridge_identity(self):
        source = (LANE / 'run.sh').read_text()
        guard = source[source.index('bridge_pid="'):source.index('\nequill_vars=()')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bridge.pid').write_text(str(os.getpid()))
            for identity in ('', 'lane:wrong-pid', f'lane:{os.getpid()}'):
                with self.subTest(identity=identity):
                    (root / 'bridge.identity').write_text(identity)
                    result = subprocess.run(['bash', '-c', 'say() { echo "$*"; };\n' + guard],
                        env=dict(os.environ, bridge_dir=str(root)), capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0 if identity == f'lane:{os.getpid()}' else 2)
                    if result.returncode:
                        self.assertIn('refusing before claim', result.stdout)

    def test_harnesses_share_cbm_connector_and_preserve_broker_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / 'settings.json'
            settings.write_text('{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[]}]}}')
            home = root / 'codex'
            home.mkdir()
            auth = home / 'auth.json'
            auth.write_text('fixture broker auth')
            env = dict(os.environ, CBM_MCP_COMMAND=str(root / 'shared connector.py'))
            subprocess.run(['bash', str(LANE / 'hooks/codex-home.sh'), str(home), str(settings)],
                           env=env, check=True, capture_output=True)
            codex = tomllib.loads((home / 'config.toml').read_text())['mcp_servers']
            claude = json.loads((home / 'mcp.json').read_text())['mcpServers']
            self.assertEqual(set(codex), {'codebase-memory'})
            self.assertEqual(set(claude), set(codex))
            self.assertEqual(codex['codebase-memory']['command'], claude['codebase-memory']['command'])
            self.assertEqual(codex, claude)
            self.assertEqual(codex['codebase-memory'], {
                'command': 'python3', 'args': [str(root / 'shared connector.py')]})
            self.assertEqual(auth.read_text(), 'fixture broker auth')

    def test_bridge_uses_lane_identity_and_refuses_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            equill = root / 'equill-fixture'
            equill.write_text('#!/bin/sh\nprintf "actor=%s verb=%s\\n" "$EQUILL_ACTOR" "$1"\n')
            equill.chmod(0o755)
            env = dict(os.environ, MEDULLA_BRIDGE=str(root), EQUILL_BIN=str(equill),
                       EQUILL_ACTOR='host-admin-fixture', EQUILL_BRIDGE_POLL='0.01')
            with subprocess.Popen(['bash', str(LANE / 'bridge/equill-bridge.sh')], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True) as process:
                try:
                    bridge = root / 'equill'
                    self.wait_for(bridge / 'bridge.pid', process)
                    self.assertEqual((bridge / 'bridge.identity').read_text().strip(), f'lane:{process.pid}')
                    for index, verb in enumerate(('context', 'search', 'record', 'revoke')):
                        key = f'fixture-{index}'
                        request = bridge / 'req' / f'{key}.json'
                        temp = request.with_suffix('.tmp')
                        temp.write_text(json.dumps({'argv': [verb], 'env': {'EQUILL_ACTOR': 'gm'}}))
                        temp.rename(request)
                        rc = bridge / 'resp' / f'{key}.rc'
                        self.wait_for(rc, process)
                        if verb in ('context', 'search'):
                            self.assertEqual(rc.read_text(), '0')
                            self.assertEqual((bridge / 'resp' / f'{key}.out').read_text(),
                                             f'actor=lane verb={verb}\n')
                        else:
                            self.assertEqual(rc.read_text(), '2')
                finally:
                    process.terminate()
                    process.wait(timeout=3)

    @staticmethod
    def wait_for(file, process):
        deadline = time.monotonic() + 3
        while not file.exists():
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            if time.monotonic() >= deadline:
                raise AssertionError(f'Timed out waiting for {file}')
            time.sleep(0.01)
