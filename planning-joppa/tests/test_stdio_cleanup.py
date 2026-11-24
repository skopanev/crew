"""Keep the session leader reserved until all shutdown signals finish."""
from pathlib import Path
import signal
import sys
import unittest
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stdio import StdioRPC, group_alive
from mcp import Joppa


class ConnectionTests(unittest.TestCase):
    def test_startup_transport_failure_reconnects_once_before_tools(self):
        for reason in ("timed out", "disconnected"):
            with self.subTest(reason=reason):
                first, second = Mock(), Mock()
                first.request.side_effect = ValueError("Joppa MCP command " + reason)
                second.request.return_value = {}
                with patch("stdio.StdioRPC", side_effect=[first, second]) as factory:
                    api = Joppa("https://example.test/mcp", mcp_command=["connector"])
                self.assertEqual(factory.call_count, 2)
                first.close.assert_called_once()
                self.assertIs(api.stdio, second)
                self.assertEqual([c.args[0] for c in second.request.call_args_list],
                                 ["initialize", "notifications/initialized"])

    def test_second_connect_failure_stops_without_a_third_attempt(self):
        clients = [Mock(), Mock()]
        for client in clients:
            client.request.side_effect = ValueError("Joppa MCP command timed out")
        with patch("stdio.StdioRPC", side_effect=clients) as factory:
            with self.assertRaisesRegex(ValueError, "timed out"):
                Joppa("https://example.test/mcp", mcp_command=["connector"])
        self.assertEqual(factory.call_count, 2)
        for client in clients:
            client.close.assert_called_once()

    def test_rejected_connection_does_not_reconnect(self):
        client = Mock()
        client.request.side_effect = ValueError("Joppa rejected the MCP operation")
        with patch("stdio.StdioRPC", return_value=client) as factory:
            with self.assertRaisesRegex(ValueError, "rejected"):
                Joppa("https://example.test/mcp", mcp_command=["connector"])
        factory.assert_called_once()
        client.close.assert_called_once()

    def test_tool_timeout_never_reconnects_or_replays_the_tool_call(self):
        client = Mock()
        client.request.side_effect = [{}, None, ValueError("Joppa MCP command timed out")]
        with patch("stdio.StdioRPC", return_value=client) as factory:
            api = Joppa("https://example.test/mcp", mcp_command=["connector"])
            with self.assertRaisesRegex(ValueError, "timed out"):
                api.raw_call("joppa_batch", {"operations": []})
        factory.assert_called_once()
        self.assertEqual([c.args[0] for c in client.request.call_args_list],
                         ["initialize", "notifications/initialized", "tools/call"])


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

    def test_permission_error_on_zombie_group_still_reaps_the_leader(self):
        rpc = self.rpc()
        with patch("stdio.os.killpg", side_effect=PermissionError):
            rpc.close()
        rpc.process.wait.assert_called_once_with(timeout=2)
        rpc.selector.close.assert_called_once()
        rpc.process.stdin.close.assert_called_once()
        rpc.process.stdout.close.assert_called_once()

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
