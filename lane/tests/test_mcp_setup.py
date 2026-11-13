"""Check MCP configuration and Joppa context startup without accounts or live services."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import tomllib
import unittest

LANE = Path(__file__).resolve().parents[1]
TRUST = '--dangerously-bypass-hook-trust'
IMAGE = os.environ.get('LANE_TEST_IMAGE', 'medulla-crew:latest')


def image_ready():
    return bool(shutil.which('docker')) and subprocess.run(
        ['docker', 'image', 'inspect', IMAGE], capture_output=True).returncode == 0


def workflow_codex_args():
    """Scout agent args and the Codex reviewer flag, as lane/workflow.yaml configures them."""
    text = (LANE / 'workflow.yaml').read_text()
    scout = text[text.index('\n  cbm_discovery:'):]
    scout = scout[:scout.index('\n  create_worktree:')]
    reviewer = text[text.index('\n    - harness: codex'):]
    reviewer = reviewer[:reviewer.index('\n    - harness:', 1)]
    args = re.search(r'\n      args: \[([^\]]*)\]', scout).group(1)
    flag = re.search(r'\n      flag: (\S+)', reviewer)
    return [arg.strip() for arg in args.split(',')], flag and flag.group(1)


class ResponsesStub(BaseHTTPRequestHandler):
    """One shell call, then a final message: the Responses stream Codex reads."""
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data":[],"models":[]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if any(isinstance(item, dict) and item.get('type') == 'function_call_output' for item in body.get('input', [])):
            item = {'type': 'message', 'id': 'msg_1', 'role': 'assistant', 'status': 'completed',
                    'content': [{'type': 'output_text', 'text': 'stub-done', 'annotations': []}]}
        else:
            item = {'type': 'function_call', 'id': 'fc_1', 'call_id': 'call_1', 'name': 'exec_command',
                    'arguments': json.dumps({'cmd': 'echo stub-tool-ran'})}
        done = {'id': 'resp_1', 'status': 'completed', 'output': [item], 'usage': {
            'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2,
            'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}}}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for event in ({'type': 'response.created', 'response': {**done, 'status': 'in_progress', 'output': []}},
                      {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                      {'type': 'response.completed', 'response': done}):
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())


class McpSetupTests(unittest.TestCase):
    def test_context_startup_requires_config_token_and_all_role_names(self):
        script = (
            'set -euo pipefail\n'
            'say() { printf "%s\\n" "$*"; }\n'
            'mounts=()\n'
            'project="fixture-proj"\n'
            'ticket="task-1"\n'
            'module="core"\n'
            f'source "{LANE / "startup/context.sh"}"\n'
            'jq -cn --argjson mounts "$(printf "%s\\0" "${mounts[@]}" | jq -Rs "split(\\"\\u0000\\")[:-1]")" '
            '--argjson vars "$(printf "%s\\0" "${context_vars[@]}" | jq -Rs "split(\\"\\u0000\\")[:-1]")" '
            '"{mounts: \\$mounts, vars: \\$vars}"\n'
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            missing = subprocess.run(['bash', '-c', script], env=dict(os.environ, LANE_MEMORY_DIR=''),
                                     capture_output=True, text=True)
            self.assertEqual(missing.returncode, 2)
            self.assertIn('Joppa context config and workspace Read key are required', missing.stdout)

            (root / 'config.json').write_text(json.dumps({
                'roles': {role: f'alpha-{role}' for role in ('scout', 'coder', 'qa', 'reviewer', 'gitfix')}}))
            no_token = subprocess.run(['bash', '-c', script], env=dict(os.environ, LANE_MEMORY_DIR=str(root)),
                                      capture_output=True, text=True)
            self.assertEqual(no_token.returncode, 2)

            (root / 'token').write_text('jpr_' + '0' * 64 + '\n')
            for missing_role in ('scout', 'coder', 'reviewer', 'gitfix'):
                roles = {role: f'alpha-{role}' for role in ('scout', 'coder', 'qa', 'reviewer', 'gitfix')}
                roles[missing_role] = '   '
                (root / 'config.json').write_text(json.dumps({'roles': roles}))
                bad_role = subprocess.run(['bash', '-c', script], env=dict(os.environ, LANE_MEMORY_DIR=str(root)),
                                          capture_output=True, text=True)
                self.assertEqual(bad_role.returncode, 2)
                self.assertIn(f'context.roles.{missing_role} is required', bad_role.stdout)

            (root / 'config.json').write_text(json.dumps({
                'roles': {role: f'alpha-{role}' for role in ('scout', 'coder', 'qa', 'reviewer', 'gitfix')}}))
            ready = subprocess.run(['bash', '-c', script], env=dict(os.environ, LANE_MEMORY_DIR=str(root)),
                                   capture_output=True, text=True)
            self.assertEqual(ready.returncode, 0, ready.stderr)
            parsed = json.loads(ready.stdout.splitlines()[-1])
            self.assertEqual(parsed['mounts'], ['--mount', str(root)])
            self.assertIn(f'LANE_MEMORY_CONFIG=/workspace/{root.name}/config.json', parsed['vars'])
            self.assertIn('LANE_MEMORY_scout_ROLE=alpha-scout', parsed['vars'])
            self.assertIn('LANE_MEMORY_coder_ROLE=alpha-coder', parsed['vars'])
            self.assertIn('LANE_MEMORY_reviewer_ROLE=alpha-reviewer', parsed['vars'])
            self.assertIn('LANE_MEMORY_gitfix_ROLE=alpha-gitfix', parsed['vars'])

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

    def test_injected_hooks_bind_joppa_memory_hook_for_both_harnesses(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tooling = root / 'custom-tooling'
            injected = root / 'claude.json'
            home = root / 'codex'
            env = dict(os.environ, TOOLING_ROOT=str(tooling), CBM_MCP_COMMAND=str(root / 'cbm.py'))
            subprocess.run(['bash', str(LANE / 'hooks/inject.sh'), str(injected),
                            str(LANE / 'hooks/claude-settings.json')], env=env, check=True, capture_output=True)
            subprocess.run(['bash', str(LANE / 'hooks/codex-home.sh'), str(home), str(injected)],
                           env=env, check=True, capture_output=True)
            claude_hooks = json.loads(injected.read_text())['hooks']
            codex_hooks = json.loads((home / 'hooks.json').read_text())['hooks']
            expected_cmd = f'bash {tooling}/lane/hooks/memory-hook.sh'
            for event in ('SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolBatch', 'Stop'):
                self.assertEqual(claude_hooks[event][0]['hooks'][0]['command'], expected_cmd)
                self.assertEqual(codex_hooks[event][0]['hooks'][0]['command'], expected_cmd)
            self.assertEqual(claude_hooks['PreToolUse'][0]['matcher'], '*')
            self.assertEqual(codex_hooks['PreToolUse'][0]['matcher'], '*')
            self.assertEqual(codex_hooks['PreToolUse'][0]['hooks'][0]['command'], expected_cmd)

    @unittest.skipUnless(image_ready(), f'Docker image {IMAGE} required')
    def test_image_codex_fires_lane_hooks_only_with_the_workflow_trust_flag(self):
        args, reviewer_flag = workflow_codex_args()
        self.assertIn(TRUST, args)
        self.assertEqual(reviewer_flag, TRUST)
        server = ThreadingHTTPServer(('0.0.0.0', 0), ResponsesStub)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def deliveries(codex_args):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                logger = root / 'logger.sh'
                logger.write_text('cat >> "$HOOK_LOG"; echo >> "$HOOK_LOG"\n')
                hook = [{'type': 'command', 'command': f'bash {logger}'}]
                settings = root / 'settings.json'
                settings.write_text(json.dumps({'hooks': {
                    'SessionStart': [{'hooks': hook}], 'PreToolUse': [{'matcher': 'Bash', 'hooks': hook}],
                    'PostToolUse': [{'matcher': '*', 'hooks': hook}], 'Stop': [{'hooks': hook}]}}))
                home = root / 'codex-home'
                subprocess.run(['bash', str(LANE / 'hooks/codex-home.sh'), str(home), str(settings)], check=True,
                               env=dict(os.environ, CBM_MCP_COMMAND='/unused.py'), capture_output=True)
                # The stub replaces the account; hooks.json is Crew's own output.
                (home / 'config.toml').write_text(
                    'model = "stub-model"\nmodel_provider = "stub"\n[model_providers.stub]\nname = "stub"\n'
                    f'base_url = "http://host.docker.internal:{server.server_address[1]}/v1"\n'
                    'wire_api = "responses"\nenv_key = "STUB_KEY"\n')
                run = subprocess.run([
                    'docker', 'run', '--rm', '--add-host', 'host.docker.internal:host-gateway',
                    '--user', f'{os.getuid()}:{os.getgid()}',
                    '-v', f'{root}:{root}', '-w', str(root), '-e', f'HOME={root}', '-e', f'CODEX_HOME={home}',
                    '-e', f'HOOK_LOG={root}/hooks.jsonl', '-e', 'STUB_KEY=stub', '--entrypoint', 'timeout', IMAGE,
                    '50', 'codex', 'exec', '--skip-git-repo-check', '--json', *codex_args, 'Run echo once.'],
                    capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
                self.assertEqual(run.returncode, 0, run.stderr[-2000:])
                self.assertIn('stub-tool-ran', run.stdout)
                log = root / 'hooks.jsonl'
                return [json.loads(line) for line in log.read_text().splitlines() if line.strip()] if log.exists() else []

        self.assertEqual(deliveries([arg for arg in args if arg != TRUST]), [])
        events = deliveries(args)
        self.assertEqual([event['hook_event_name'] for event in events], ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'])
        pre, post, stop = events[1:]
        self.assertEqual((pre['tool_name'], pre['tool_input']), ('Bash', {'command': 'echo stub-tool-ran'}))
        self.assertEqual(post['tool_use_id'], pre['tool_use_id'])
        self.assertIn('tool_response', post)
        self.assertEqual(stop['last_assistant_message'], 'stub-done')
