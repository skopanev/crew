"""Opt-in Docker check of real worktree stages and filesystem permissions."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from test_failure_outcome import shell_body


@unittest.skipUnless(os.environ.get('LANE_TEST_DOCKER') == '1', 'set LANE_TEST_DOCKER=1')
class SourceMountTests(unittest.TestCase):
    def test_sources_are_read_only_while_worktree_can_commit_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='lane-mounts-', dir='/tmp') as directory:
            root = Path(directory).resolve()
            repo = root / 'sources/repo'
            sibling = root / 'sources/companion'
            tooling = root / 'tooling'
            runs = root / 'runs'
            for folder in (repo, sibling / '.git', tooling / 'repo',
                           tooling / 'sources', tooling / '.git', tooling / 'lane/bin', runs):
                folder.mkdir(parents=True, exist_ok=True)
            (repo / '.ntkrc').write_text('{"target_branch":"develop"}\n')
            (repo / 'README.md').write_text('original\n')
            (sibling / 'README.md').write_text('context\n')
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
            git('init', '-q', '-b', 'develop')
            git('add', '.')
            git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local',
                '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'initial')
            initial = git('rev-parse', 'HEAD')
            git('remote', 'add', 'origin', '/workspace/repo')
            (tooling / 'lane/bin/ticket-outcome.mjs').write_text(
                '// Local stand-in: this test never contacts NTK.\nconsole.log("fixture status");\n')
            (runs / 'create.sh').write_text(shell_body('create_worktree'))
            (runs / 'cleanup.sh').write_text(shell_body('cleanup'))
            script = '''set -euo pipefail
trap 'cat "$MEDULLA_RUN_DIR/"*.log 2>/dev/null || true' EXIT
for source in /workspace/repo/README.md /workspace/sources/repo/README.md /workspace/sources/companion/README.md; do
  if (printf forbidden >> "$source") 2>/dev/null; then
    echo "source is writable: $source"; exit 1
  fi
done
bash "$MEDULLA_RUN_DIR/create.sh" > "$MEDULLA_RUN_DIR/create.log"
grep -q '<signal:READY>' "$MEDULLA_RUN_DIR/create.log"
wt="$LANE_WT_ROOT/wt-$ticket_id"
test "$(cat "$wt/../companion/README.md")" = context
printf 'candidate\n' >> "$wt/README.md"
git -C "$wt" add README.md
git -C "$wt" -c user.name=fixture -c user.email=fixture@local -c core.hooksPath=/dev/null commit -qm candidate
test "$(git -C "$wt" rev-list --count origin/develop..HEAD)" = 1
# A repeated start must preserve both the saved commit and its registration.
bash "$MEDULLA_RUN_DIR/create.sh" > "$MEDULLA_RUN_DIR/repeat.log"
grep -q '<signal:BRANCH_HAS_WORK>' "$MEDULLA_RUN_DIR/repeat.log"
git -C "$wt" rev-parse HEAD >/dev/null
bash "$MEDULLA_RUN_DIR/cleanup.sh"
test ! -d "$wt"
test "$(cat /workspace/repo/README.md)" = original
echo 'PASS: source writes denied; context readable; worktree commit and cleanup succeed'
'''
            env = dict(project_dir='/workspace/repo', repository_git_dir='/workspace/.git',
                       source_root='/workspace/sources', ticket_id='fixture', project_name='fixture',
                       TOOLING_ROOT='/workspace', MEDULLA_RUN_DIR=str(runs),
                       LANE_WT_ROOT=str(runs / 'worktrees'))
            args = ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'bash']
            for source, target, mode in ((tooling, '/workspace', 'ro'),
                                         (root / 'sources', '/workspace/sources', 'ro'),
                                         (repo, '/workspace/repo', 'ro'),
                                         (repo / '.git', '/workspace/.git', 'rw'),
                                         (runs, str(runs), 'rw')):
                args += ['-v', f'{source}:{target}:{mode}']
            for name, value in env.items():
                args += ['-e', f'{name}={value}']
            args += [os.environ.get('MEDULLA_IMAGE', 'medulla-crew:latest'), '-c', script]
            result = subprocess.run(args, capture_output=True, text=True, timeout=60)
            # Docker Desktop releases nested bind mountpoints after the CLI exits.
            time.sleep(1)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('PASS:', result.stdout)
            self.assertEqual(git('rev-parse', 'HEAD'), initial)
            self.assertEqual(git('status', '--porcelain'), '')
            self.assertEqual(git('worktree', 'list', '--porcelain').count('worktree '), 1)
