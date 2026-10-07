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
        def obj(address, title, parent=None, **data):
            return {"workspace": "test", "position": 1, "address": address,
                    "id": address.split(":", 1)[1], "item_id": None, "current_revision": 1,
                    "document": {"revision": 1, "parent": parent, "present": True,
                                 "data": {"title": title, **data}, "links": []},
                    "references": [], "annotations": {}}
        self.objects = {
            "area:domain-1": obj("area:domain-1", "Reliable delivery", description="", owner="owner"),
            "service:cap-1": obj("service:cap-1", "Bounded work scheduling", "area:domain-1",
                                 description="", owner="owner"),
        }
        requirement = obj("requirement:req-1", "Expected outcome", "service:cap-1",
                          body="One bounded change", consumers=[], owner="owner")
        requirement["item_id"] = "test-R-0123456789"
        self.detail = {"workspace": "test", "position": 1, "object": requirement,
                      "system_ids": {"ac": {"ac-1": "test-A-0123456789"},
                                     "requirement": {"req-1": "test-R-0123456789"}},
                      "process": {"confirmed": True}, "requirement": {
            "id": "requirement:req-1", "current_revision": 1, "revisions": [{"number": 1, "title": "Expected outcome",
            "body": "One bounded change", "capability": None, "consumers": [], "owner": "owner", "confirmed": True,
            "acs": [{"id": "ac:ac-1", "text": "The predicate returns true", "description": "", "owner": None,
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
                    assert request["params"]["name"] in ("joppa_read", "joppa_objects"), "admission must never write"
                    arguments = request["params"]["arguments"]
                    peer.calls.append(arguments)
                    data = deepcopy(peer.objects[arguments["address"]] if "address" in arguments else peer.detail)
                    if "req" in arguments:
                        data.pop("object")
                    if peer.root and (peer.root / "joppa-changed").exists() and data.get("address") == "area:domain-1":
                        data["document"]["data"]["description"] = "Changed during planning"
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
