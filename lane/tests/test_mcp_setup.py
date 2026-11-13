"""Check MCP configuration and Joppa context startup without accounts or live services."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest

LANE = Path(__file__).resolve().parents[1]


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
            for missing_role in ('scout', 'coder', 'qa', 'reviewer', 'gitfix'):
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
            self.assertIn('LANE_MEMORY_qa_ROLE=alpha-qa', parsed['vars'])
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
