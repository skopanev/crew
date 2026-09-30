"""Real Git fixtures verify canonical sync and the CBM completion lock."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'lane-launcher/safe-sync.py'


class SafeSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'sources'
        self.source.mkdir()
        self.origin = self.root / 'origin.git'
        self.seed = self.root / 'seed'
        self.repo = self.source / 'app'
        self.git('init', '--bare', str(self.origin))
        self.git('clone', str(self.origin), str(self.seed))
        for key, value in [('user.email', 'fixture@example.test'), ('user.name', 'Fixture')]:
            self.git('-C', str(self.seed), 'config', key, value)
        self.git('-C', str(self.seed), 'checkout', '-b', 'main')
        (self.seed / '.ntkrc').write_text('{"target_branch":"main"}')
        (self.seed / 'file.txt').write_text('before\n')
        self.commit(self.seed, 'initial')
        self.git('-C', str(self.seed), 'push', 'origin', 'main')
        self.git('clone', '-b', 'main', str(self.origin), str(self.repo))
        self.events = self.root / 'events'
        self.connector = self.root / 'connector.py'
        self.connector.write_text('''import datetime,fcntl,json,os,pathlib,sys
poll = 0
repo = pathlib.Path(os.environ['SYNC_REPO'])
for line in sys.stdin:
 r = json.loads(line)
 if 'id' not in r: continue
 if r['method'] == 'initialize': result = {}
 else:
  name = r['params']['name']
  with (repo / '.git/sync.lock').open('a') as lock:
   try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
   except BlockingIOError: pass
   else: raise RuntimeError('sync released its lock before CBM completed')
  if name == 'index_repository':
   poll = 0
   with open(os.environ['SYNC_EVENTS'],'a') as f: f.write('start\\n')
   result = {'status':'queued'}
  else:
   poll += 1
   ready = poll >= 3
   result = {'status':'ready' if poll != 2 else 'indexing',
             'indexed_at':datetime.datetime.now(datetime.timezone.utc).isoformat() if ready else '2000-01-01T00:00:00Z'}
   if ready:
    with open(os.environ['SYNC_EVENTS'],'a') as f: f.write('done\\n')
  result = {'structuredContent':result}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
''')
        self.env = dict(os.environ, SYNC_REPO=str(self.repo), SYNC_EVENTS=str(self.events))

    def git(self, *args):
        return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, repo, message):
        self.git('-C', str(repo), 'add', '.')
        self.git('-C', str(repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                 '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message)

    def launch(self):
        return subprocess.Popen([sys.executable, str(SCRIPT), str(self.source), str(self.connector)],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_detached_checkout_fast_forwards_and_waits_for_new_ready_index(self):
        self.git('-C', str(self.repo), 'checkout', '--detach')
        (self.seed / 'file.txt').write_text('after\n')
        self.commit(self.seed, 'remote change')
        self.git('-C', str(self.seed), 'push', 'origin', 'main')
        child = self.launch()
        out, err = child.communicate(timeout=15)
        self.assertEqual(child.returncode, 0, err)
        self.assertEqual((self.repo / 'file.txt').read_text(), 'after\n')
        self.assertEqual(self.git('-C', str(self.repo), 'branch', '--show-current'), 'main')
        self.assertEqual(self.git('-C', str(self.repo), 'rev-parse', 'HEAD'),
                         self.git('-C', str(self.seed), 'rev-parse', 'HEAD'))
        self.assertEqual(self.events.read_text(), 'start\ndone\n')
        self.assertIn('Git and shared CBM ready', out)

    def test_dirty_missing_target_and_local_commits_are_preserved_and_refused(self):
        original = (self.repo / '.ntkrc').read_text()
        for change in ['dirty', 'missing-target', 'ahead']:
            with self.subTest(change=change):
                if change == 'dirty': (self.repo / 'file.txt').write_text('local edit\n')
                elif change == 'missing-target': (self.repo / '.ntkrc').write_text('{}')
                else:
                    (self.repo / 'file.txt').write_text('local commit\n')
                    self.commit(self.repo, 'local')
                before = self.git('-C', str(self.repo), 'rev-parse', 'HEAD')
                child = self.launch()
                _, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 2, err)
                self.assertEqual(self.git('-C', str(self.repo), 'rev-parse', 'HEAD'), before)
                self.assertFalse(self.events.exists())
                if change == 'dirty': (self.repo / 'file.txt').write_text('before\n')
                elif change == 'missing-target': (self.repo / '.ntkrc').write_text(original)

    def test_two_launches_queue_until_git_and_cbm_are_done(self):
        first = self.launch()
        second = self.launch()
        for child in (first, second):
            _, err = child.communicate(timeout=20)
            self.assertEqual(child.returncode, 0, err)
        self.assertEqual(self.events.read_text(), 'start\ndone\nstart\ndone\n')


if __name__ == '__main__':
    unittest.main()
