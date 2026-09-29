"""The preflight talks MCP to a shared service; it never manages an index."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PROBE = Path(__file__).resolve().parents[1] / 'bridge/cbm-probe.py'


class SharedCBMTests(unittest.TestCase):
    def test_connection_and_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            connector = root / 'connector.py'
            connector.write_text('''import json, os, sys
for line in sys.stdin:
 r = json.loads(line)
 with open(os.environ['REQUESTS'], 'a') as log:
  log.write(json.dumps(r) + '\\n')
 if 'id' not in r: continue
 method = r['method']
 case = os.environ['CASE']
 if case == 'disconnect': sys.exit(0)
 if method == 'initialize': result = {'protocolVersion': '2024-11-05', 'capabilities': {}}
 elif method == 'tools/list':
  names = ['search_code'] if case == 'missing_tools' else ['search_code', 'search_graph']
  result = {'tools': [{'name': name} for name in names]}
 else:
  result = {'isError': case == 'unindexed', 'content': [{'type': 'text', 'text': 'search result'}]}
 print(json.dumps({'jsonrpc': '2.0', 'id': r['id'], 'result': result}), flush=True)
''')
            for case in ('ready', 'missing_tools', 'unindexed', 'disconnect'):
                with self.subTest(case=case):
                    requests = root / f'{case}.jsonl'
                    result = subprocess.run([sys.executable, str(PROBE), str(connector), 'repo'],
                        env={**os.environ, 'CASE': case, 'REQUESTS': str(requests)},
                        capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0 if case == 'ready' else 2, result.stderr)
                    calls = [json.loads(line) for line in requests.read_text().splitlines()]
                    self.assertTrue(all(r['method'] in {'initialize', 'notifications/initialized',
                        'tools/list', 'tools/call'} for r in calls))
                    searches = [r['params'] for r in calls if r['method'] == 'tools/call']
                    self.assertTrue(all(r['name'] == 'search_code' for r in searches))
                    if case == 'ready':
                        self.assertEqual(len(searches), 1)
                        self.assertEqual(searches[0]['arguments']['project'], 'repo')
