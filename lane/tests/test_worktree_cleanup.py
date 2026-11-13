"""Failed runs may delete only their own demonstrably unchanged checkout."""
import os
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


RUN = Path(__file__).resolve().parents[1] / 'run.sh'
TEXT = RUN.read_text()
CLEANUP_TEXT = (RUN.parent / 'startup/cleanup.sh').read_text()
CLEANUP = CLEANUP_TEXT[CLEANUP_TEXT.index('cleanup() {'):]
WORKTREE = (RUN.parent / 'startup/worktree.sh').read_text()


class WorktreeCleanupTests(unittest.TestCase):
    def test_retained_candidate_refresh_keeps_cache_and_restores_commit_hooks(self):
        for route in ('coder', 'review', 'changed-head', 'dirty'):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                source, wt, run = root / 'source', root / 'ticket', root / 'run'
                source.mkdir()
                (run / 'artifacts').mkdir(parents=True)
                def git(cwd, *args):
                    return subprocess.check_output(['git', '-C', str(cwd), *args], text=True).strip()
                git(source, 'init', '-q', '-b', 'main')
                git(source, 'config', 'user.name', 'fixture')
                git(source, 'config', 'user.email', 'fixture@local')
                (source / '.gitignore').write_text('node_modules/\ndist/\n')
                (source / '.githooks').mkdir()
                (source / '.githooks/pre-commit').write_text('#!/bin/sh\necho ran >> .git/commit-hook-ran\n')
                (source / 'code.txt').write_text('base\n')
                git(source, 'add', '.')
                git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base')
                base = git(source, 'rev-parse', 'HEAD')
                git(root, 'clone', '-q', str(source), str(wt))
                git(wt, 'checkout', '-qb', 'ticket-fixture')
                git(wt, 'config', 'user.name', 'lane')
                git(wt, 'config', 'user.email', 'lane@local')
                (wt / 'code.txt').write_text('implementation\n')
                git(wt, 'add', '.')
                git(wt, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'SAVE STATE: implement_code')
                head, tree = git(wt, 'rev-parse', 'HEAD'), git(wt, 'rev-parse', 'HEAD^{tree}')
                (wt / '.git/lane-base').write_text(base + '\n')
                for folder in ('node_modules', 'dist'):
                    (wt / folder).mkdir()
                    (wt / folder / 'warm').write_text('preserve\n')
                (source / 'independent.txt').write_text('target moved\n')
                git(source, 'add', '.')
                git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'new target')
                target = git(source, 'rev-parse', 'HEAD')
                retained = {'head': base if route == 'changed-head' else head, 'tree': tree,
                            'base': base, 'route': 'review' if route == 'review' else 'coder'}
                (run / 'artifacts/claim.json').write_text(json.dumps({'ticket': {'retained': retained}}))
                if route == 'dirty':
                    (wt / 'new.txt').write_text('unowned change\n')
                env = dict(os.environ, TOOLING_ROOT=str(RUN.parent.parent), LANE_WORKTREE=str(wt),
                           MEDULLA_RUN_DIR=str(run), project_dir=str(source), ticket_id='fixture', TARGET_BRANCH='main')
                result = subprocess.run(['bash', str(RUN.parent / 'bin/retained-worktree.sh')],
                                        env=env, capture_output=True, text=True, timeout=20)
                if route in ('dirty', 'changed-head'):
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('<signal:RETAINED_CHANGED>', result.stdout)
                    self.assertEqual(git(wt, 'rev-parse', 'HEAD'), head)
                    continue
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('<signal:RESUME_REVIEW>' if route == 'review' else '<signal:READY>', result.stdout)
                self.assertEqual(git(wt, 'rev-parse', 'HEAD'), target)
                self.assertEqual((wt / '.git/lane-base').read_text().strip(), target)
                self.assertEqual(git(wt, 'diff', '--cached', '--name-only'), 'code.txt')
                git(wt, 'commit', '-qm', 'Joppa Task implementation')
                self.assertEqual((wt / '.git/commit-hook-ran').read_text(), 'ran\n')
                for folder in ('node_modules', 'dist'):
                    self.assertEqual((wt / folder / 'warm').read_text(), 'preserve\n')

    def test_confirmed_delivery_cleans_checkout_and_preserves_failed_hook(self):
        for case in ('none', 'success', 'failed', 'mutation', 'verified'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                wt, repo = root / 'ticket', root / 'source'
                wt.mkdir()
                repo.mkdir()
                def git(*args):
                    return subprocess.check_output(['git', '-C', str(wt), *args], text=True).strip()
                git('init', '-q')
                git('config', 'user.name', 'fixture')
                git('config', 'user.email', 'fixture@local')
                (wt / 'source.txt').write_text('base\n')
                git('add', '.')
                git('commit', '-qm', 'base')
                base = git('rev-parse', 'HEAD')
                (wt / 'source.txt').write_text('delivered\n')
                git('add', '.')
                git('commit', '-qm', 'delivered')
                head = git('rev-parse', 'HEAD')
                git('update-ref', 'refs/remotes/origin/main', head)
                (wt / '.git/lane-base').write_text(base + '\n')
                if case == 'verified':
                    (wt / '.git/lane-verified').touch()
                hook = repo / 'after-land'
                hook.write_text('#!/usr/bin/env python3\nimport json,os,pathlib,sys\n'
                    'pathlib.Path(os.environ["HOOK_ARGS"]).write_text(json.dumps(sys.argv[1:]))\n'
                    'if os.environ["HOOK_CASE"] == "mutation": pathlib.Path("source.txt").write_text("unexpected")\n'
                    'sys.exit(42 if os.environ["HOOK_CASE"] == "failed" else 0)\n')
                hook.chmod(0o755)
                env = dict(os.environ, worktree=str(wt), worktree_created='true', target='main',
                    LANE_DELIVERY='target', repo=str(repo), after_land='' if case == 'none' else 'after-land',
                    HOOK_ARGS=str(root / 'args.json'), HOOK_CASE=case)
                script = 'say() { printf "%s\\n" "$*"; }\n' + CLEANUP + '\ntrap cleanup EXIT\nexit 0\n'
                result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(wt.exists(), case in ('failed', 'mutation'))
                self.assertEqual((root / 'args.json').exists(), case not in ('none', 'verified'))
                if (root / 'args.json').exists():
                    self.assertEqual(json.loads((root / 'args.json').read_text()), [str(wt), head, 'main', base])
                if wt.exists():
                    self.assertIn('POST_LAND_FAILED', result.stdout)
                    self.assertEqual(git('rev-parse', 'HEAD'), head)

    def test_only_successful_creation_owns_an_empty_checkout(self):
        ownership = TEXT[TEXT.index('worktree_created=false'):TEXT.index('mounts+=(--mount-rw "$worktree")')]
        for existing, reuse in ((False, False), (True, False), (False, True)):
            with self.subTest(existing=existing, reuse=reuse), tempfile.TemporaryDirectory() as directory:
                worktree = Path(directory) / 'ticket'
                if existing:
                    worktree.mkdir()
                script = ('say() { printf "%s\\n" "$*"; }\n' + WORKTREE + CLEANUP +
                          '\ntrap cleanup EXIT\n' + ownership + '\nexit 2\n')
                result = subprocess.run(['bash', '-c', script], env=dict(os.environ, worktree=str(worktree),
                                        LANE_REUSE_HEAD='a' * 40 if reuse else ''),
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 73 if existing or reuse else 2, result.stderr)
                self.assertEqual(worktree.exists(), existing)
                if existing or reuse:
                    self.assertIn('WORKTREE PREEXISTED', result.stdout)

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
                self.assertEqual(wt.exists(), case not in ('empty', 'unchanged', 'ignored'))
                if wt.exists() and case != 'symlink':
                    self.assertTrue((wt / 'source.txt').exists())


if __name__ == '__main__':
    unittest.main()
