"""A local HTTP MCP peer for admission tests; no provider or production writes."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread


class JoppaFixture:
    def __init__(self, root=None):
        self.root = root
        self.status = 200
        self.calls = []
        self.index = {"workspace": "test", "position": 1, "index": {
            "domains": {"domain-1": {"title": "Reliable delivery", "description": "", "owner": "owner",
                                      "confirmed": True, "archived": False}},
            "capabilities": {"cap-1": {"title": "Bounded work scheduling", "description": "", "owner": "owner",
                                        "confirmed": True, "domain": "domain-1"}}}}
        self.detail = {"workspace": "test", "position": 1, "requirement": {
            "id": "req-1", "current_revision": 1, "revisions": [{"number": 1, "title": "Expected outcome",
            "body": "One bounded change", "capability": "cap-1", "consumers": [], "owner": "owner", "confirmed": True,
            "acs": [{"id": "ac-1", "text": "The predicate returns true", "description": "", "owner": None,
                     "depends_on": [], "before_launch": False}], "tasks": {}, "runs": {}}]}}
        peer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                status = peer.status
                if self.headers.get("Authorization") != "Bearer test-only-token":
                    status = 401
                if request["method"] == "initialize":
                    result = {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {"name": "test", "version": "1"}}
                else:
                    assert request["method"] == "tools/call"
                    assert request["params"]["name"] == "joppa_read", "admission must never write"
                    arguments = request["params"]["arguments"]
                    peer.calls.append(arguments)
                    data = deepcopy(peer.detail if "req" in arguments else peer.index)
                    if peer.root and (peer.root / "joppa-changed").exists() and "index" in data:
                        data["index"]["domains"]["domain-1"]["description"] = "Changed during planning"
                    result = {"content": [{"type": "text", "text": json.dumps(data)}]}
                body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.env = {"JOPPA_MCP_URL": f"http://127.0.0.1:{self.server.server_port}/mcp", "JOPPA_TOKEN": "test-only-token",
                    "JOPPA_TOKEN_FILE": ""}

    def close(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
