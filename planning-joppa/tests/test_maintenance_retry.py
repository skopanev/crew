"""Repeat a tool call only on the explicit Joppa maintenance answer, with the same payload."""
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import joppa_reads
import mcp
from joppa_reads import Maintenance, MCPError

MAINTENANCE = {"code": -32000, "message": "Maintenance. Try in 30 seconds."}


def stdio_server(fails, error=MAINTENANCE):
    # Answer initialize, then fail the first `fails` tool calls with `error`, then succeed. Print each call at the end.
    return [sys.executable, "-u", "-c", (
        "import json,sys\n"
        f"fails={fails}; error={json.dumps(error)!r}; calls=[]\n"
        "for line in sys.stdin:\n"
        " r=json.loads(line)\n"
        " if 'id' not in r: continue\n"
        " if r['method']=='initialize': print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'protocolVersion':'2025-03-26'}}),flush=True); continue\n"
        " calls.append(r['params'])\n"
        " if len(calls)<=fails: print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':json.loads(error)}),flush=True)\n"
        " else: print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'structuredContent':{'calls':calls}}}),flush=True)\n")]


class StdioTests(unittest.TestCase):
    def joppa(self, fails, error=MAINTENANCE):
        api = mcp.Joppa("https://joppa.example/mcp", mcp_command=stdio_server(fails, error))
        self.addCleanup(api.stdio.close)
        return api

    def test_maintenance_waits_and_repeats_the_same_call_with_the_same_request_id(self):
        api = self.joppa(2)
        with patch.object(joppa_reads.time, "sleep") as sleep:
            result = api.raw_call("joppa_batch", {"operations": [], "request_id": "r-1"})
        self.assertEqual(sleep.call_count, 2); sleep.assert_called_with(30)
        self.assertEqual(result["calls"], [{"name": "joppa_batch", "arguments": {"operations": [], "request_id": "r-1"}}] * 3)

    def test_maintenance_stops_after_three_repeats(self):
        api = self.joppa(9)
        with patch.object(joppa_reads.time, "sleep") as sleep, self.assertRaises(Maintenance):
            api.raw_call("joppa_objects", {"address": "ac:a"})
        self.assertEqual(sleep.call_count, 3)

    def test_another_error_is_not_repeated(self):
        for message in ["Write conflict", "Not in maintenance. Write conflict.", "Maintenance. Try in 30 seconds. Write conflict."]:
            api = self.joppa(1, {"code": -32000, "message": message})
            with patch.object(joppa_reads.time, "sleep") as sleep, self.assertRaisesRegex(ValueError, "rejected"):
                api.raw_call("joppa_batch", {"request_id": "r-2"})
            sleep.assert_not_called()


class HttpTests(unittest.TestCase):
    def joppa(self, *answers):
        api = object.__new__(mcp.Joppa)
        api.url, api.stdio, api.token, api.sequence, api.session, api.protocol = "https://joppa.example/mcp", None, "t", 0, None, "2025-03-26"
        sent = []
        def open_(request, timeout):
            payload = json.loads(request.data); sent.append(payload)
            answer = answers[len(sent) - 1]
            if isinstance(answer, Exception):
                raise answer
            body = json.dumps({"jsonrpc": "2.0", "id": payload["id"], **answer}).encode()
            response = Mock(); response.read.return_value = body; response.headers = {"Content-Type": "application/json"}
            response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
            return response
        api.opener = Mock(open=open_)
        return api, sent

    def busy(self, retry_after="30"):
        return HTTPError("https://joppa.example/mcp", 503, "Service Unavailable", {"Retry-After": retry_after} if retry_after else {}, io.BytesIO())

    def test_http_503_with_retry_after_and_the_rpc_answer_repeat_the_same_payload(self):
        ok = {"result": {"structuredContent": {"saved": True}}}
        api, sent = self.joppa(self.busy(), {"error": MAINTENANCE}, ok)
        with patch.object(joppa_reads.time, "sleep") as sleep:
            self.assertEqual(api.raw_call("joppa_batch", {"request_id": "r-3"}), {"saved": True})
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual([row["params"] for row in sent], [{"name": "joppa_batch", "arguments": {"request_id": "r-3"}}] * 3)

    def test_http_without_maintenance_and_transport_errors_are_not_repeated(self):
        other = {"error": {"code": -32000, "message": "Not in maintenance. Write conflict."}}
        for answer in [self.busy(None), HTTPError("u", 500, "x", {}, io.BytesIO()), URLError("down"), other]:
            api, sent = self.joppa(answer)
            with patch.object(joppa_reads.time, "sleep") as sleep, self.assertRaises(MCPError) as caught:
                api.raw_call("joppa_batch", {"request_id": "r-4"})
            sleep.assert_not_called(); self.assertEqual(len(sent), 1)
            self.assertNotIsInstance(caught.exception, Maintenance)


if __name__ == "__main__":
    unittest.main()
