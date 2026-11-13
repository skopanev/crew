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
            context = root / 'crew-context-fixture'
            hooks = root / 'crew-hooks-fixture'
            for folder in (tooling / 'lane/bridge', tooling / 'lane-launcher', bins, context, hooks,
                           sources / 'app/.git', sources / 'infra/.git', sources / 'locks', root / 'cache'):
                folder.mkdir(parents=True)
            shutil.copy(CREW / 'lane/run.sh', tooling / 'lane/run.sh')
            shutil.copytree(CREW / 'lane/startup', tooling / 'lane/startup')
            shutil.copy(CREW / 'lane-launcher/scope.mjs', tooling / 'lane-launcher/scope.mjs')
            shutil.copy(CREW / 'lane-launcher/runtime.mjs', tooling / 'lane-launcher/runtime.mjs')
            (tooling / 'lane/bridge/cbm-connect.py').write_text(
                "import pathlib,sys\n"
                "path=pathlib.Path(sys.argv[-1]+'-fixture')\n"
                "path.write_text('# fixture connector\\n')\nprint(path)\n")
            (root / 'connector.py').write_text('# fixture connector\n')
            (root / 'connector.py').chmod(0o755)
            (tooling / 'lane-launcher/safe-sync.py').write_text(
                'import json,os,sys\n'
                'open(os.environ["TEST_SYNC"],"w").write(json.dumps(sys.argv[1:]))\n'
                'sys.exit(int(os.environ.get("TEST_SYNC_FAILURE","0")))\n')
            (context / 'token').write_text('jpr_' + 'a' * 64 + '\n')
            (context / 'token').chmod(0o600)
            (context / 'config.json').write_text(json.dumps({
                'roles': {role: f'fixture-{role}' for role in ('scout', 'coder', 'qa', 'reviewer', 'gitfix')}}))
            (hooks / 'settings.json').write_text('{"hooks":{}}')
            for name, script in {
                'docker': '#!/bin/sh\nexit 0\n',
                'medulla': '#!/usr/bin/env python3\nimport json,os,sys\n'
                           'open(os.environ["TEST_ARGS"],"w").write(json.dumps(sys.argv[1:]))\n'
                           'open(os.environ["TEST_ARGS"]+".cwd","w").write(os.getcwd())\n'
                           'sys.exit(int(os.environ.get("TEST_MEDULLA_FAILURE","0")))\n',
            }.items():
                file = bins / name
                file.write_text(script)
                file.chmod(0o755)
            output = root / 'args.json'
            env = dict(os.environ, PATH=str(bins) + os.pathsep + os.environ['PATH'],
                       MEDULLA_BRIDGE=str(root / 'bridge'), LANE_RUNS_FOLDER=str(root / 'runs'),
                       LANE_MEMORY_DIR=str(context),
                       LANE_HOOKS_DIR=str(hooks),
                       LANE_CLAIM_FILE=str(root / 'claim.json'), LANE_SOURCE='joppa',
                       LANE_WORKTREE_ROOT=str(sources / '.worktrees'),
                       TEST_ARGS=str(output), TEST_SYNC=str(root / 'sync.json'))
            args = ['bash', str(tooling / 'lane/run.sh'), '--project', 'fixture',
                    '--source-root', str(sources), '--dispatcher-id', 'fixture',
                    '--cbm-mcp-command', str(root / 'connector.py'), '--cbm-cache-dir', str(root / 'cache'),
                    '--shared-lock-dir', str(sources / 'locks'), '--test-command', '["true"]',
                    '--gate-command', 'fixture-check']
            def configure(repo, path=None):
                env['LANE_REPOSITORY_JSON'] = json.dumps({'id': repo, 'path': str(path or sources / repo),
                    'targetBranch': 'main', 'cbmProject': f'{repo}-project', 'preflight': None})
            def run(ticket, extra=()):
                (root / 'claim.json').write_text(json.dumps({'id': ticket, 'workspace': 'fixture',
                    'claimed': True, 'status': 'in_progress', 'source': 'joppa',
                    'ticket': {'id': ticket, 'source': 'joppa', 'module': env['TEST_MODULE']}}))
                return subprocess.run(args + ['--ticket-id', ticket, *extra], env=env,
                                      capture_output=True, text=True, timeout=10)
            for repo, module in [('app', 'app/src/module'), ('infra', 'infra/src/module'),
                                 ('app', 'app'), ('infra', 'infra')]:
                with self.subTest(module=module):
                    env['TEST_MODULE'] = module
                    configure(repo)
                    ticket = f'{repo}-ticket' if '/' in module else f'{repo}-root-ticket'
                    result = run(ticket)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    launch = json.loads(output.read_text())
                    mounts = [(launch[i], launch[i+1]) for i in range(len(launch)-1)
                              if launch[i] in ('--mount', '--mount-rw')]
                    self.assertEqual(mounts, [('--mount', str(sources)),
                                             ('--mount-rw', str(sources / 'locks')),
                                             ('--mount', str(context)),
                                             ('--mount', str(hooks)),
                                             ('--mount-rw', str(sources / '.worktrees' / ticket))])
                    self.assertIn(f'LANE_MEMORY_CONFIG=/workspace/{context.name}/config.json', launch)
                    self.assertIn(f'LANE_HOOKS_CONFIG=/workspace/{hooks.name}/settings.json', launch)
                    self.assertIn('LANE_MEMORY_scout_ROLE=fixture-scout', launch)
                    self.assertIn(f'project_dir=/workspace/sources/{repo}', launch)
                    self.assertIn(f'LANE_WORKTREE=/workspace/{ticket}', launch)
                    self.assertIn(f'CBM_PROJECT={repo}-project', launch)
                    self.assertIn('TICKET_SOURCE=joppa', launch)
                    self.assertIn('TARGET_BRANCH=main', launch)
                    self.assertNotIn('repository_git_dir=/workspace/.git', launch)
                    synced = json.loads((root / 'sync.json').read_text())
                    self.assertEqual(synced[0], str(sources))
                    self.assertTrue(synced[1].endswith('/mcp.py-fixture'))
                    self.assertIn(f'CBM_MCP_COMMAND={synced[1]}', launch)
                    self.assertEqual(synced[2], env.get('MEDULLA_IMAGE', 'medulla-crew:latest'))
            # Without a project workflow, Medulla runs Crew's lane workflow from the Crew root.
            self.assertEqual(launch[launch.index('-w') + 1], 'lane')
            self.assertNotIn('TOOLING_ROOT=/workspace', launch)
            self.assertEqual(Path(str(output) + '.cwd').read_text(), str(tooling))
            output.unlink()
            # The Joppa reader also uses the path returned by Broker.
            env['LANE_JOPPA_MCP_COMMAND_JSON'] = '["node","reader.cjs"]'
            result = run('reader-ticket')
            self.assertEqual(result.returncode, 0, result.stderr)
            launch = json.loads(output.read_text())
            reader = next(arg for arg in launch if arg.startswith('JOPPA_READER_COMMAND_JSON='))
            self.assertTrue(json.loads(reader.split('=', 1)[1])[1].endswith('/mcp.cjs-fixture'))
            env.pop('LANE_JOPPA_MCP_COMMAND_JSON')
            output.unlink()
            # The configured repository must stay inside the source root.
            outside = root / 'outside'
            (outside / '.git').mkdir(parents=True)
            configure('outside', outside)
            result = run('outside-ticket')
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('configured repository escapes sourceRoot', result.stderr)
            self.assertFalse(output.exists())
            # Only the Joppa lane worker starts a lane.
            configure('app')
            env.pop('LANE_SOURCE')
            result = run('manual-ticket')
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('start through the Joppa lane worker', result.stderr)
            self.assertFalse(output.exists())
            env['LANE_SOURCE'] = 'joppa'
            # A startup sync failure never reaches Medulla or creates a checkout.
            env['TEST_MODULE'] = 'infra/src/module'
            configure('infra')
            env['TEST_SYNC_FAILURE'] = '2'
            result = run('sync-failed')
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())
            self.assertFalse((sources / '.worktrees/sync-failed').exists())
            env.pop('TEST_SYNC_FAILURE')
            # A failed Medulla startup leaves no unused checkout behind.
            env['TEST_MEDULLA_FAILURE'] = '2'
            result = run('unused-tree')
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((sources / '.worktrees/unused-tree').exists())
            env.pop('TEST_MEDULLA_FAILURE')
            # --dry-run still probes CBM but never invokes source/index mutation.
            (root / 'sync.json').unlink()
            result = run('preview', ['--dry-run'])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / 'sync.json').exists())
            # A project workflow outside Crew is passed by its real path; one inside Crew stays relative.
            outside_flow = root / 'project-flow/workflow.yaml'
            inside_flow = tooling / 'flows/workflow.yaml'
            for flow in (outside_flow, inside_flow):
                flow.parent.mkdir(parents=True)
                flow.write_text('version: "2"\n')
            (root / 'flow-link').symlink_to(outside_flow.parent)
            for given, expected in [(root / 'flow-link/workflow.yaml', str(outside_flow)),
                                    (inside_flow, 'flows/workflow.yaml')]:
                with self.subTest(workflow=str(given)):
                    env['LANE_WORKFLOW_FILE'] = str(given)
                    result = run(f'flow-{len(expected)}')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    launch = json.loads(output.read_text())
                    self.assertEqual(launch[launch.index('-w') + 1], expected)
                    self.assertIn('TOOLING_ROOT=/workspace', launch)
                    self.assertEqual(Path(str(output) + '.cwd').read_text(), str(tooling))
            # An invalid project workflow stops before Medulla and before the checkout.
            (root / 'empty-flow').mkdir()
            (root / 'empty-flow/workflow.yaml').write_text('')
            (root / 'custom.yaml').write_text('version: "2"\n')
            output.unlink()
            for invalid in ['project-flow/workflow.yaml', str(root / 'custom.yaml'),
                            str(root / 'missing/workflow.yaml'), str(root / 'empty-flow/workflow.yaml')]:
                with self.subTest(invalid=invalid):
                    env['LANE_WORKFLOW_FILE'] = invalid
                    result = run('bad-flow')
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('LANE_WORKFLOW_FILE must name', result.stderr)
                    self.assertFalse(output.exists())
                    self.assertFalse((sources / '.worktrees/bad-flow').exists())
            env.pop('LANE_WORKFLOW_FILE')
            # Existing work belongs to its owner: refusal must happen before Medulla.
            retained = sources / '.worktrees/app-ticket/keep.txt'
            retained.parent.mkdir()
            retained.write_text('saved work\n')
            output.unlink(missing_ok=True)
            env['TEST_MODULE'] = 'app/src/module'
            configure('app')
            result = run('app-ticket')
            self.assertEqual(result.returncode, 73)
            self.assertIn('WORKTREE PREEXISTED', result.stderr)
            self.assertEqual(retained.read_text(), 'saved work\n')
            self.assertFalse(output.exists())
