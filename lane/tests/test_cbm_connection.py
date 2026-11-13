"""The preflight talks MCP to a shared service; it never manages an index."""
import json
import os
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PROBE = Path(__file__).resolve().parents[1] / 'bridge/cbm-probe.py'


class SharedCBMTests(unittest.TestCase):
    def test_bridge_reports_the_broker_connector_path(self):
        bridge = runpy.run_path(str(PROBE.with_name('cbm-connect.py')))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            calls = []
            def connect(name, command, output, **kwargs):
                calls.append((name, command, kwargs))
                path = output + '-digest'
                Path(path).write_text('# connector\n')
                return path
            broker = types.ModuleType('broker')
            box = types.ModuleType('broker.box')
            box.connect_mcp = connect
            from contextlib import redirect_stdout, redirect_stderr
            from io import StringIO
            with patch.dict(sys.modules, {'broker': broker, 'broker.box': box}), \
                 patch.dict(os.environ, {'LANE_JOPPA_MCP_COMMAND_JSON': '["node","reader.cjs"]'}):
                for name in ('codebase-memory', 'joppa'):
                    with self.subTest(name=name):
                        output = str(root / name)
                        out, err = StringIO(), StringIO()
                        with redirect_stdout(out), redirect_stderr(err):
                            if name == 'joppa': bridge['prepare_joppa'](output)
                            else: bridge['prepare']('/server', temp, temp, output)
                        self.assertEqual(out.getvalue(), output + '-digest\n')
                        self.assertTrue(Path(out.getvalue().strip()).is_file())
                        self.assertFalse(Path(output).exists())
                        self.assertIn('ready (broker)', err.getvalue())
            self.assertEqual(calls[0][2]['roots'], [str(root)])
            self.assertEqual(calls[1][2]['lang'], 'js')

    def test_container_connector_is_inside_its_mount_after_resolving_an_alias(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            folder = root / 'actual'
            folder.mkdir()
            connector = folder / 'mcp.py'
            connector.write_text('''import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if 'id' in r: print(json.dumps({'id':r['id'],'result':{}}),flush=True)
''')
            alias = root / 'alias'
            alias.symlink_to(folder, target_is_directory=True)
            bins = root / 'bin'
            bins.mkdir()
            docker = bins / 'docker'
            docker.write_text(f'''#!{sys.executable}
import os,pathlib,sys
args=sys.argv[1:]
source,target,mode=args[args.index('-v')+1].rsplit(':',2)
script=pathlib.Path(args[-1])
if script.parent != pathlib.Path(target) or not script.is_file():
 sys.exit('connector is outside its Docker mount')
os.execv(sys.executable,[sys.executable,str(script)])
''')
            docker.chmod(0o755)
            before = os.environ['PATH']
            os.environ['PATH'] = str(bins) + os.pathsep + before
            try:
                session = runpy.run_path(str(PROBE))['session']
                with session(str(alias / 'mcp.py'), image='fixture') as call:
                    self.assertEqual(call('tools/list', {}), {})
            finally:
                os.environ['PATH'] = before

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
