"""Role contracts and lessons come through the lane adapter. A local mock Joppa, no network."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contracts


class Joppa(BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        payload = json.dumps(self.server.replies.pop(0)).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), Joppa)
        self.server.requests, self.server.replies = [], []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (folder / "key").write_text("jpr_" + "ab" * 32)
        (folder / "context.json").write_text(json.dumps({
            "url": f"http://127.0.0.1:{self.server.server_port}/api/data", "workspace": "crew",
            "token_file": str(folder / "key"), "root": "requirement:roles",
            "roles": {"researcher": "crew-planning-researcher", "critic": "crew-planning-critic"},
            "filter_env": {"role": "LANE_MEMORY_ROLE", "process": "LANE_MEMORY_PROCESS", "project": "LANE_MEMORY_PROJECT"},
            "session": {"kind": ["process", "rule"], "fields": ["title", "body"]},
            "query": {"kind": "lesson", "fields": ["title", "body"], "limit": 8,
                      "filter_env": {"project": "LANE_MEMORY_PROJECT"}}}))
        self.enterContext(patch.dict(os.environ, {"LANE_MEMORY_CONFIG": str(folder / "context.json")}))

    def test_a_contract_is_the_rendered_text_with_its_records_and_digest(self):
        self.server.replies.append({"workspace": "crew", "position": 41, "items": [
            {"address": "process:crew-planning-critic", "revision": 3, "title": "Critic", "body": "Reject gaps."},
            {"address": "rule:ste", "revision": 1, "title": "Writing", "body": "Use STE."}]})
        contract = contracts.load_contract("critic", "life")
        content = "## Critic\nReject gaps.\n\n## Writing\nUse STE.\n"
        self.assertEqual(contract, {"role": "crew-planning-critic", "content": content,
                                    "record_ids": ["process:crew-planning-critic@3", "rule:ste@1"],
                                    "bundle_digest": hashlib.sha256(content.encode()).hexdigest()})
        self.assertEqual(self.server.requests[0]["filter"],
                         {"role": "crew-planning-critic", "process": "crew-planning-critic", "project": "life"})

    def test_a_contract_without_text_or_receipt_is_refused(self):
        self.server.replies.append({"items": [{"address": "process:p", "title": "P", "body": "Text."}]})
        with self.assertRaisesRegex(ValueError, "without address or revision"):
            contracts.load_contract("researcher", "life")
        self.server.replies.append({"items": [{"address": "process:p", "revision": 2, "title": "P"}]})
        with self.assertRaisesRegex(ValueError, "without text: process:p"):
            contracts.load_contract("researcher", "life")

    def test_a_role_without_a_configured_process_is_refused(self):
        with self.assertRaisesRegex(ValueError, "config.context.roles.designer is missing"):
            contracts.load_contract("designer", "life")
        self.assertEqual(self.server.requests, [])

    def test_lessons_may_be_empty(self):
        self.server.replies.append({"workspace": "crew", "position": 7, "items": []})
        self.assertEqual(contracts.load_knowledge("life", "panel sign-in")[1], "")
        self.assertEqual(self.server.requests[0]["query"], "panel sign-in")
        self.assertEqual(self.server.requests[0]["filter"], {"project": "life"})


if __name__ == "__main__":
    unittest.main()
