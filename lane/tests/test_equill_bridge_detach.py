"""The shared Equill bridge must survive the lane that started it."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

LANE = Path(__file__).resolve().parents[1]
STARTER = '''set -u
say() { echo "$*"; }
project=p ticket=t module=m
source "$LANE/startup/equill.sh"
echo "ready $$"
sleep 60
'''


@unittest.skipUnless(shutil.which('jq'), 'the bridge needs jq')
class EquillBridgeDetachTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # A private copy of the bridge: its path names only this test's processes.
        self.workflow = self.root / 'lane'
        (self.workflow / 'bridge').mkdir(parents=True)
        shutil.copy(LANE / 'bridge/equill-bridge.sh', self.workflow / 'bridge')
        fake = self.root / 'bin/equill'
        fake.parent.mkdir()
        fake.write_text('#!/bin/sh\necho "fake-equill $*"\n')
        fake.chmod(0o755)
        self.bridge_root = self.root / 'medulla-bridge'
        self.env = dict(os.environ, MEDULLA_BRIDGE=str(self.bridge_root), WORKFLOW_DIR=str(self.workflow),
                        LANE=str(LANE), EQUILL_BIN=str(fake), EQUILL_BRIDGE_POLL='0.05',
                        PATH=f'{fake.parent}{os.pathsep}{os.environ["PATH"]}')
        self.starters = []
        self.live = self.live_bridge()
        self.addCleanup(self.cleanup)

    @staticmethod
    def live_bridge():
        try:
            return Path('/tmp/medulla-bridge/equill/bridge.pid').read_text().strip()
        except OSError:
            return None

    def start(self):
        # Each starter plays a lane: its own session and process group.
        starter = subprocess.Popen(['bash', '-c', STARTER], env=self.env, start_new_session=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.starters.append(starter)
        return starter

    def bridge_pids(self):
        """Every process running this test's private bridge copy."""
        out = subprocess.run(['ps', '-A', '-o', 'pid=,command='], capture_output=True, text=True).stdout
        mark = str(self.workflow / 'bridge/equill-bridge.sh')
        return sorted(int(line.split(None, 1)[0]) for line in out.splitlines()
                      if mark in line and 'ps -A' not in line)

    def pidfile(self):
        return int((self.bridge_root / 'equill/bridge.pid').read_text())

    def client(self):
        shim = LANE / 'bridge/equill-shim.sh'
        env = dict(self.env, EQUILL_BRIDGE=str(self.bridge_root / 'equill'), EQUILL_BRIDGE_TIMEOUT='10')
        return subprocess.run(['bash', str(shim), 'context', '--query=after-lane-exit'],
                              env=env, capture_output=True, text=True, timeout=20)

    def wait_ready(self, starter):
        line = starter.stdout.readline()
        while line and not line.startswith('ready'):
            line = starter.stdout.readline()
        self.assertTrue(line.startswith('ready'), 'starter did not reach ready')

    def cleanup(self):
        mine = os.getpgid(0)
        for starter in self.starters:
            if starter.poll() is None:
                os.killpg(starter.pid, signal.SIGKILL)
            starter.wait()
            starter.stdout.close()
        for pid in self.bridge_pids():
            try:
                group = os.getpgid(pid)
            except ProcessLookupError:
                continue
            self.assertNotEqual(group, mine)
            os.killpg(group, signal.SIGTERM)
        for _ in range(50):
            if not self.bridge_pids():
                break
            time.sleep(0.1)
        self.assertEqual(self.bridge_pids(), [], 'test bridge survived cleanup')
        # The live shared bridge is never a test process: its pidfile stays as it was.
        self.assertEqual(self.live_bridge(), self.live)

    def test_bridge_survives_signal_to_starter_group(self):
        starter = self.start()
        self.wait_ready(starter)
        bridge = self.pidfile()
        evidence = subprocess.run(['ps', '-o', 'pid,pgid,sid,command', '-p', f'{starter.pid},{bridge}'],
                                  capture_output=True, text=True).stdout
        print(f'\nstarter pid {starter.pid}, bridge pid {bridge}\n{evidence}', file=sys.stderr)
        self.assertNotEqual(os.getpgid(bridge), os.getpgid(starter.pid))
        self.assertNotEqual(os.getsid(bridge), os.getsid(starter.pid))
        os.killpg(starter.pid, signal.SIGTERM)  # what the lane worker does on exit
        starter.wait(timeout=10)
        time.sleep(0.5)
        os.kill(bridge, 0)
        self.assertEqual(self.pidfile(), bridge)
        result = self.client()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fake-equill context --query=after-lane-exit', result.stdout)
        refused = subprocess.run(['bash', str(LANE / 'bridge/equill-shim.sh'), 'record', 'x'],
                                 env=dict(self.env, EQUILL_BRIDGE=str(self.bridge_root / 'equill')),
                                 capture_output=True, text=True, timeout=20)
        self.assertEqual(refused.returncode, 2)
        self.assertIn('read-only', refused.stderr)
        self.assertEqual((self.bridge_root / 'equill/bridge.identity').read_text().strip(), f'lane:{bridge}')

    def test_concurrent_starts_leave_one_bridge(self):
        first, second = self.start(), self.start()
        self.wait_ready(first)
        self.wait_ready(second)
        time.sleep(0.5)
        bridge = self.pidfile()
        # One lock-holding supervisor and its one bridge shell, in one group.
        pids = self.bridge_pids()
        self.assertIn(bridge, pids)
        self.assertEqual(len({os.getpgid(pid) for pid in pids}), 1, pids)
        self.assertEqual(len(pids), 2, pids)
        result = self.client()
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
