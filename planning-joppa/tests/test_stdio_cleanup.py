"""Keep the session leader reserved until all shutdown signals finish."""
from pathlib import Path
import signal
import sys
import unittest
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stdio import StdioRPC, group_alive


class CleanupTests(unittest.TestCase):
    def rpc(self):
        rpc = object.__new__(StdioRPC)
        rpc.process = Mock(pid=1234)
        rpc.selector = Mock()
        rpc.closed = False
        return rpc

    def test_zombie_leader_is_reaped_only_after_group_signals_finish(self):
        rpc, events = self.rpc(), []
        rpc.process.wait.side_effect = lambda **_: events.append("wait")
        with patch("stdio.os.killpg", side_effect=lambda *args: events.append(args)), \
             patch("stdio.subprocess.check_output", return_value="1234 Z\n5678 S\n"):
            rpc.close()
        self.assertEqual(events, [(1234, signal.SIGTERM), "wait"])
        rpc.process.poll.assert_not_called()
        rpc.process.wait.assert_called_once_with(timeout=2)
        rpc.selector.close.assert_called_once()
        rpc.close()
        rpc.process.wait.assert_called_once()

    def test_live_group_escalates_before_the_leader_is_reaped(self):
        rpc = self.rpc()
        with patch("stdio.os.killpg") as send, \
             patch("stdio.subprocess.check_output", side_effect=["1234 S\n", "1234 Z\n"]), \
             patch("stdio.time.monotonic", side_effect=[0, 0, 3, 3, 3]), patch("stdio.time.sleep"):
            rpc.process.wait.side_effect = lambda **_: self.assertEqual(
                send.call_args_list, [call(1234, signal.SIGTERM), call(1234, signal.SIGKILL)])
            rpc.close()
        rpc.process.poll.assert_not_called()
        rpc.process.wait.assert_called_once_with(timeout=2)

    def test_group_probe_ignores_other_groups_and_keeps_live_descendants(self):
        with patch("stdio.subprocess.check_output", return_value="1234 Z\n1234 S+\n5678 S\n") as probe:
            self.assertTrue(group_alive(1234))
            probe.assert_called_once_with(["ps", "-axo", "pgid=,stat="], text=True, timeout=2)
        with patch("stdio.subprocess.check_output", side_effect=PermissionError):
            self.assertTrue(group_alive(1234))

    def test_probe_failure_still_escalates_before_reaping_the_leader(self):
        rpc = self.rpc()
        with patch("stdio.os.killpg") as send, \
             patch("stdio.subprocess.check_output", side_effect=PermissionError), \
             patch("stdio.time.monotonic", side_effect=[0, 0, 3, 3, 3, 6]), patch("stdio.time.sleep"):
            rpc.close()
        self.assertEqual(send.call_args_list, [call(1234, signal.SIGTERM), call(1234, signal.SIGKILL)])
        rpc.process.poll.assert_not_called()
        rpc.process.wait.assert_called_once_with(timeout=2)
