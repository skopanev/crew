"""Keep the session leader reserved until all shutdown signals finish."""
from pathlib import Path
import signal
import sys
import unittest
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stdio import StdioRPC, group_alive
from mcp import Joppa


class ResponseTests(unittest.TestCase):
    def test_two_late_responses_preserve_notifications_and_server_ping(self):
        server = (
            "import json,sys\n"
            "requests=[json.loads(sys.stdin.readline()) for _ in range(3)]\n"
            "messages=[{'jsonrpc':'2.0','method':'notifications/progress','params':{}},\n"
            " {'jsonrpc':'2.0','id':1,'method':'ping','params':{}},\n"
            " {'jsonrpc':'2.0','id':1,'error':{'code':-32000,'message':'late error'}},\n"
            " {'jsonrpc':'2.0','id':2,'result':{}}]\n"
            "print('\\n'.join(json.dumps(m) for m in messages),flush=True)\n"
            "pong=json.loads(sys.stdin.readline())\n"
            "print(json.dumps({'jsonrpc':'2.0','id':3,'result':"
            "{'pong':pong,'methods':[r['method'] for r in requests]}}),flush=True)\n"
        )
        rpc = StdioRPC([sys.executable, "-u", "-c", server])
        try:
            with patch.object(rpc.selector, "select", return_value=[]):
                for _ in range(2):
                    with self.assertRaisesRegex(ValueError, "timed out"):
                        rpc.request("tools/call", {"name": "mutation"})
            result = rpc.request("tools/list", {})
            self.assertEqual(result["pong"], {"jsonrpc": "2.0", "id": 1, "result": {}})
            self.assertEqual(result["methods"], ["tools/call", "tools/call", "tools/list"])
            self.assertEqual(rpc.expired, set())
        finally:
            rpc.close()

    def test_late_reply_after_timeout_does_not_poison_later_requests(self):
        server = (
            "import json,sys\n"
            "seen=[]\n"
            "for line in sys.stdin:\n"
            " r=json.loads(line)\n"
            " seen.append(r['method'])\n"
            " print(json.dumps({'jsonrpc':'2.0','id':r['id'],"
            "'result':{'seen':seen}}),flush=True)\n"
        )
        rpc = StdioRPC([sys.executable, "-u", "-c", server])
        try:
            with patch.object(rpc.selector, "select", return_value=[]):
                with self.assertRaisesRegex(ValueError, "timed out"):
                    rpc.request("tools/call", {"name": "mutation"})
            self.assertEqual(rpc.request("tools/list", {}), {"seen": ["tools/call", "tools/list"]})
            self.assertEqual(rpc.request("ping", {}), {"seen": ["tools/call", "tools/list", "ping"]})
            self.assertEqual(rpc.sequence, 3)
            self.assertEqual(rpc.expired, set())
        finally:
            rpc.close()

    def test_unknown_and_null_response_ids_still_fail(self):
        for wrong in ("999", "null"):
            with self.subTest(wrong=wrong):
                server = "import sys\nsys.stdin.readline()\nprint('" + (
                    '{"jsonrpc":"2.0","id":' + wrong + ',"result":{}}'
                ) + "',flush=True)\n"
                rpc = StdioRPC([sys.executable, "-u", "-c", server])
                try:
                    with self.assertRaisesRegex(ValueError, "different MCP response.*expected 1, received"):
                        rpc.request("tools/list", {})
                finally:
                    rpc.close()


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
