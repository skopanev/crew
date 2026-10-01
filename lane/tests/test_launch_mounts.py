"""Exercise run.sh preparation without claiming a ticket or starting Medulla."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


CREW = Path(__file__).resolve().parents[2]


class LaunchMountTests(unittest.TestCase):
    def test_ticket_source_and_only_its_checkout_are_mounted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            tooling = root / 'crew'
            sources = root / 'sources'
            bins = root / 'bin'
            bridge = root / 'bridge/equill'
            for folder in (tooling / 'lane', tooling / 'lane-launcher', bins, bridge,
                           sources / 'app/.git', sources / 'infra/.git'):
                folder.mkdir(parents=True)
            for repo in ('app', 'infra'):
                (sources / repo / '.ntkrc').write_text('{"target_branch":"main"}\n')
            shutil.copy(CREW / 'lane/run.sh', tooling / 'lane/run.sh')
            shutil.copy(CREW / 'lane-launcher/scope.mjs', tooling / 'lane-launcher/scope.mjs')
            (tooling / 'lane-launcher/ntk.mjs').write_text(
                'export async function getTicket(id) { return {id, module: process.env.TEST_MODULE}; }\n')
            (root / 'connector.py').write_text('# fixture connector\n')
            (tooling / 'lane-launcher/safe-sync.py').write_text(
                'import json,os,sys\n'
                'open(os.environ["TEST_SYNC"],"w").write(json.dumps(sys.argv[1:]))\n'
                'sys.exit(int(os.environ.get("TEST_SYNC_FAILURE","0")))\n')
            (bridge / 'bridge.pid').write_text(str(os.getpid()))
            (bridge / 'bridge.identity').write_text(f'lane:{os.getpid()}')
            for name, script in {
                'docker': '#!/bin/sh\nexit 0\n',
                'medulla': '#!/usr/bin/env python3\nimport json,os,sys\n'
                           'open(os.environ["TEST_ARGS"],"w").write(json.dumps(sys.argv[1:]))\n'
                           'sys.exit(int(os.environ.get("TEST_MEDULLA_FAILURE","0")))\n',
            }.items():
                file = bins / name
                file.write_text(script)
                file.chmod(0o755)
            output = root / 'args.json'
            env = dict(os.environ, PATH=str(bins) + os.pathsep + os.environ['PATH'],
                       MEDULLA_BRIDGE=str(root / 'bridge'), LANE_RUNS_FOLDER=str(root / 'runs'),
                       TEST_ARGS=str(output), TEST_SYNC=str(root / 'sync.json'))
            args = ['bash', str(tooling / 'lane/run.sh'), '--project', 'fixture',
                    '--source-root', str(sources), '--dispatcher-id', 'fixture',
                    '--cbm-mcp-command', str(root / 'connector.py'), '--gate-command', 'fixture-check']
            for repo, module in [('app', 'app/src/module'), ('infra', 'infra/src/module'),
                                 ('app', 'app'), ('infra', 'infra')]:
                with self.subTest(module=module):
                    env['TEST_MODULE'] = module
                    ticket = f'{repo}-ticket' if '/' in module else f'{repo}-root-ticket'
                    result = subprocess.run(args + ['--ticket-id', ticket], env=env,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    launch = json.loads(output.read_text())
                    mounts = [(launch[i], launch[i+1]) for i in range(len(launch)-1)
                              if launch[i] in ('--mount', '--mount-rw')]
                    self.assertEqual(mounts, [('--mount', str(sources)),
                                             ('--mount-rw', str(sources / '.worktrees' / ticket))])
                    self.assertIn(f'project_dir=/workspace/sources/{repo}', launch)
                    self.assertIn(f'LANE_WORKTREE=/workspace/{ticket}', launch)
                    self.assertIn(f'CBM_PROJECT={str(sources / repo).lstrip("/").replace("/", "-")}', launch)
                    self.assertNotIn('repository_git_dir=/workspace/.git', launch)
                    synced = json.loads((root / 'sync.json').read_text())
                    self.assertEqual(synced[0], str(sources))
                    self.assertEqual(synced[2], env.get('MEDULLA_IMAGE', 'medulla-crew:latest'))
            output.unlink()
            for module in ('.', '..', './app', '../app', '/app'):
                with self.subTest(invalid_module=module):
                    env['TEST_MODULE'] = module
                    result = subprocess.run(args + ['--ticket-id', 'invalid-module'], env=env,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('module must name a repository', result.stderr)
                    self.assertFalse(output.exists())
            # A startup sync failure never reaches Medulla or creates a checkout.
            env['TEST_MODULE'] = 'infra/src/module'
            env['TEST_SYNC_FAILURE'] = '2'
            result = subprocess.run(args + ['--ticket-id', 'sync-failed'], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())
            self.assertFalse((sources / '.worktrees/sync-failed').exists())
            env.pop('TEST_SYNC_FAILURE')
            # A failed Medulla startup leaves no unused checkout behind.
            env['TEST_MEDULLA_FAILURE'] = '2'
            result = subprocess.run(args + ['--ticket-id', 'unused-tree'], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((sources / '.worktrees/unused-tree').exists())
            env.pop('TEST_MEDULLA_FAILURE')
            # --dry-run still probes CBM but never invokes source/index mutation.
            (root / 'sync.json').unlink()
            result = subprocess.run(args + ['--ticket-id', 'preview', '--dry-run'], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / 'sync.json').exists())
            # Existing work belongs to its owner: refusal must happen before Medulla.
            retained = sources / '.worktrees/app-ticket/keep.txt'
            retained.write_text('saved work\n')
            output.unlink()
            env['TEST_MODULE'] = 'app/src/module'
            result = subprocess.run(args + ['--ticket-id', 'app-ticket'], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 73)
            self.assertIn('WORKTREE PREEXISTED', result.stderr)
            self.assertEqual(retained.read_text(), 'saved work\n')
            self.assertFalse(output.exists())
            # The landing target has no default: refuse before claim or Medulla.
            env['TEST_MODULE'] = 'infra/src/module'
            ntkrc = sources / 'infra/.ntkrc'
            for content in (None, '{}', '{"target_branch":""}', '{"target_branch":7}',
                            '{"target_branch":"-main"}', '{"target_branch":"a..b"}',
                            '{"target_branch":"HEAD"}', 'not json'):
                with self.subTest(ntkrc=content):
                    if content is None:
                        ntkrc.unlink(missing_ok=True)
                    else:
                        ntkrc.write_text(content)
                    result = subprocess.run(args + ['--ticket-id', 'target-ticket'], env=env,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('must set target_branch to a legal branch name', result.stderr)
                    self.assertFalse(output.exists())
                    self.assertFalse((sources / '.worktrees/target-ticket').exists())
