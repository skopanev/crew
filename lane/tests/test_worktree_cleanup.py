"""Failed runs may delete only their own demonstrably unchanged checkout."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


RUN = Path(__file__).resolve().parents[1] / 'run.sh'
TEXT = RUN.read_text()
CLEANUP = TEXT[TEXT.index('cleanup() {'):TEXT.index('trap cleanup EXIT')]


class WorktreeCleanupTests(unittest.TestCase):
    def test_failure_cleanup_preserves_work_and_existing_trees(self):
        cases = ('empty', 'unchanged', 'changed', 'untracked', 'ignored',
                 'committed', 'existing', 'no-baseline', 'success', 'symlink')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                wt = root / 'ticket'
                wt.mkdir()

                def git(*args):
                    return subprocess.check_output(
                        ['git', '-C', str(wt), *args], text=True).strip()

                if case != 'empty':
                    git('init', '-q')
                    (wt / 'source.txt').write_text('base\n')
                    (wt / '.gitignore').write_text('generated/\n')
                    git('add', '.')
                    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local',
                        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base')
                    base = git('rev-parse', 'HEAD')
                    if case != 'no-baseline':
                        (wt / '.git/lane-base').write_text(base + '\n')
                    if case == 'changed':
                        (wt / 'source.txt').write_text('implementation\n')
                    elif case == 'untracked':
                        (wt / 'new.txt').write_text('implementation\n')
                    elif case == 'ignored':
                        (wt / 'generated').mkdir()
                        (wt / 'generated/result.txt').write_text('retained output\n')
                    elif case == 'committed':
                        (wt / 'source.txt').write_text('implementation\n')
                        git('add', '.')
                        git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local',
                            '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'work')
                    elif case == 'symlink':
                        actual = root / 'actual'
                        wt.rename(actual)
                        wt.symlink_to(actual, target_is_directory=True)
                env = dict(os.environ, worktree=str(wt),
                           worktree_created='false' if case == 'existing' else 'true')
                code = 0 if case == 'success' else 2
                script = 'say() { printf "%s\\n" "$*"; }\n' + CLEANUP + '\ntrap cleanup EXIT\nexit ' + str(code)
                result = subprocess.run(['bash', '-c', script], env=env,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(wt.exists(), case not in ('empty', 'unchanged'))
                if wt.exists() and case != 'symlink':
                    self.assertTrue((wt / 'source.txt').exists())


if __name__ == '__main__':
    unittest.main()
