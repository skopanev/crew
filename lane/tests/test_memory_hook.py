"""The lane memory hook reads Joppa through joppa-data.sh. A local mock HTTP server, no network."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

HOOKS = Path(__file__).resolve().parents[1] / "hooks"
TOKEN = "jpr_" + "0123456789abcdef" * 4


class Joppa(BaseHTTPRequestHandler):
    """Record each POST and answer with the next queued reply."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        status, reply = self.server.replies.pop(0) if self.server.replies else (200, {"items": []})
        payload = json.dumps(reply).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class MemoryHookTests(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), Joppa)
        self.server.requests, self.server.replies = [], []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (self.folder / "token").write_text(TOKEN + "\n")
        self.config = {
            "url": f"http://127.0.0.1:{self.server.server_port}/api/data", "workspace": "crew",
            "token_file": str(self.folder / "token"), "root": "requirement:lane",
            "filter_env": {"role": "LANE_MEMORY_ROLE", "project": "LANE_MEMORY_PROJECT"},
            "session": {"kind": ["guide", "process", "rule"], "filter": {"scope": "lane"},
                        "fields": ["title", "body", "ends_when"], "max_chars": 20000},
            "stop": {"kind": "process", "field": "ends_when", "filter_env": {"name": "LANE_MEMORY_PROCESS"}},
            "query": {"kind": ["lesson"], "fields": ["title", "body"], "limit": 5, "max_chars": 4000,
                      "filter_env": {"project": "LANE_MEMORY_PROJECT"}},
            "assignment": {"ticket": "task:t1", "module": "life"},
        }
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.folder), "TMPDIR": str(self.folder),
                    "MEDULLA_RUN_DIR": str(self.folder), "LANE_MEMORY_ROLE": "crew-lane-coder",
                    "LANE_MEMORY_PROJECT": "life", "LANE_MEMORY_PROCESS": "implement"}

    def hook(self, event, config=True, **fields):
        if config:
            (self.folder / "config.json").write_text(json.dumps(self.config))
            self.env["LANE_MEMORY_CONFIG"] = str(self.folder / "config.json")
        else:
            self.env.pop("LANE_MEMORY_CONFIG", None)
        result = subprocess.run(["bash", str(HOOKS / "memory-hook.sh")], input=json.dumps(
            {"hook_event_name": event, "session_id": "s1", **fields}), env=self.env,
            capture_output=True, text=True, timeout=30, check=True)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def test_session_start_reads_the_contract_without_a_query_and_renders_it_in_order(self):
        self.server.replies.append((200, {"workspace": "crew", "position": 9, "items": [
            {"address": "process:implement", "kind": "process", "revision": 2, "title": "Implement",
             "body": "Write the code.", "ends_when": "<signal:OK>done</signal:OK>"},
            {"address": "rule:r", "kind": "rule", "revision": 1, "title": "Rule", "body": "Keep scope."}]}))
        out = self.hook("SessionStart")
        request = self.server.requests[0]
        self.assertEqual((request["path"], request["auth"]), ("/api/data", "Bearer " + TOKEN))
        self.assertEqual(request["body"], {
            "root": "requirement:lane", "workspace": "crew", "kind": ["guide", "process", "rule"],
            "filter": {"scope": "lane", "role": "crew-lane-coder", "project": "life"},
            "fields": ["title", "body", "ends_when"], "max_chars": 20000})
        context = out["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(context, "## Implement\nWrite the code.\nends_when: <signal:OK>done</signal:OK>\n\n"
                                  "## Rule\nKeep scope.\n\n## ASSIGNMENT\n- ticket: task:t1\n- module: life")
        self.assertNotIn("continue", out)

    def test_flat_memory_omits_root_for_contract_stop_and_query(self):
        del self.config["root"]
        for event, fields in (("SessionStart", {}), ("Stop", {}),
                              ("UserPromptSubmit", {"prompt": "Run the gate"})):
            with self.subTest(event=event):
                self.server.replies.append((200, {"items": [{"address": "process:implement",
                    "body": "Keep scope.", "ends_when": "Return the result."}]}))
                out = self.hook(event, **fields)
                self.assertNotIn("root", self.server.requests[-1]["body"])
                self.assertEqual(self.server.requests[-1]["body"]["workspace"], "crew")
                self.assertNotIn("stopReason", out)
                if event == "Stop":
                    self.assertEqual(out, {"decision": "block", "reason": "Return the result."})

    def test_session_start_stops_the_lane_without_a_contract(self):
        for reply in ((422, {"error": "unknown kind"}), (500, {}), (200, {"items": []}), (200, {"rows": []}),
                      (200, {"items": [{"address": "rule:r", "title": "Rule"}]})):
            with self.subTest(reply=reply):
                self.server.replies.append(reply)
                out = self.hook("SessionStart")
                self.assertIs(out["continue"], False)
                self.assertIn("lane memory: baseline failed", out["stopReason"])
        self.assertIn("HTTP 422", self.hook_fatal_reason((422, {"error": "unknown kind"})))
        self.assertIn("items without contract text: rule:r",
                      self.hook_fatal_reason((200, {"items": [{"address": "rule:r", "title": "Rule"}]})))
        (self.folder / "token").write_text("jpr_short\n")
        self.assertIn("does not hold one Joppa read key", self.hook_fatal_reason((200, {"items": []})))
        (self.folder / "token").write_text(TOKEN + "\n")
        out = self.hook("SessionStart", config=False)
        self.assertIs(out["continue"], False)
        self.assertIn("LANE_MEMORY_CONFIG is not set", out["stopReason"])
        del self.env["LANE_MEMORY_PROJECT"]
        self.assertIn("filter variable LANE_MEMORY_PROJECT is unset", self.hook_fatal_reason((200, {"items": []})))

    def hook_fatal_reason(self, reply):
        self.server.replies.append(reply)
        return self.hook("SessionStart")["stopReason"]

    def test_stop_without_a_signal_blocks_with_the_exact_process_text(self):
        transcript = self.folder / "t.jsonl"
        transcript.write_text(json.dumps({"type": "assistant", "message": {"content": "work finished"}}) + "\n")
        self.server.replies.append((200, {"items": [{"address": "guide:lane", "title": "Lane"},
                                                    {"address": "process:implement", "title": "Implement",
                                                     "ends_when": "End with <signal:OK>result</signal:OK>."}]}))
        out = self.hook("Stop", transcript_path=str(transcript))
        self.assertEqual(out, {"decision": "block", "reason": "End with <signal:OK>result</signal:OK>."})
        self.assertEqual(self.server.requests[0]["body"], {
            "root": "requirement:lane", "workspace": "crew", "kind": "process",
            "filter": {"name": "implement"}, "fields": ["ends_when"]})
        # A failed read or an empty field blocks with the reason, never with an invented rule.
        self.server.replies.append((500, {"error": "down"}))
        reason = self.hook("Stop", transcript_path=str(transcript))["reason"]
        self.assertTrue(reason.startswith("lane memory: stop text unavailable: HTTP 500"), reason)
        self.server.replies.append((200, {"items": [{"address": "process:implement", "title": "Implement"}]}))
        self.assertEqual(self.hook("Stop", transcript_path=str(transcript))["reason"],
                         "lane memory: stop text unavailable: no item has ends_when")
        self.server.replies.append((200, {"items": [{"address": "process:a", "ends_when": "A"},
                                                    {"address": "process:b", "ends_when": "B"}]}))
        self.assertEqual(self.hook("Stop", transcript_path=str(transcript))["reason"],
                         "lane memory: stop text unavailable: several items have ends_when: process:a, process:b")
        # The loop guard and a tagged answer release without a read.
        count = len(self.server.requests)
        self.assertNotIn("decision", self.hook("Stop", transcript_path=str(transcript), stop_hook_active=True))
        transcript.write_text(json.dumps({"type": "assistant", "message": {"content": "<signal:OK>x</signal:OK>"}}))
        self.assertNotIn("decision", self.hook("Stop", transcript_path=str(transcript)))
        self.assertEqual(len(self.server.requests), count)

    def test_retrieval_sends_the_query_with_its_limit_and_warns_on_failure(self):
        self.server.replies.append((200, {"items": [{"address": "lesson:l", "title": "Lesson", "body": "Use rtk."}]}))
        out = self.hook("UserPromptSubmit", prompt="How do I run the gate?")
        self.assertEqual(self.server.requests[0]["body"], {
            "root": "requirement:lane", "workspace": "crew", "kind": ["lesson"],
            "filter": {"project": "life"}, "fields": ["title", "body"], "max_chars": 4000,
            "query": "How do I run the gate?", "limit": 5})
        self.assertEqual(out["hookSpecificOutput"]["additionalContext"], "## Lesson\nUse rtk.")
        self.server.replies.append((503, {}))
        out = self.hook("UserPromptSubmit", prompt="again")
        self.assertIn("lane memory: retrieval failed: HTTP 503", out["systemMessage"])
        self.assertNotIn("continue", out)
        self.assertEqual(self.hook("UserPromptSubmit", prompt="nothing")["hookSpecificOutput"]["additionalContext"], "")

    def test_query_keeps_2000_unicode_characters(self):
        self.hook("UserPromptSubmit", prompt="ж" * 2500)
        self.assertEqual(self.server.requests[0]["body"]["query"], "ж" * 2000)

    def test_tool_events_retrieve_once_per_tool_call(self):
        call = {"tool_name": "Bash", "tool_use_id": "u1", "tool_input": {"description": "Run the gate"},
                "tool_response": "error: gate failed", "session_id": ""}
        self.hook("PostToolUse", **call)
        self.hook("PostToolUse", **call)
        self.assertEqual(len(self.server.requests), 1)
        self.assertIn("Run the gate", self.server.requests[0]["body"]["query"])
        # The same tool ID from another node of the run is that node's first event.
        self.env["LANE_MEMORY_ROLE"] = "crew-lane-qa"
        self.hook("PostToolUse", **call)
        self.assertEqual(len(self.server.requests), 2)
        self.env["LANE_MEMORY_PROCESS"] = "verify"
        self.hook("PostToolUse", **call)
        self.assertEqual(len(self.server.requests), 3)
        del self.config["query"]
        self.hook("PostToolUse", **{**call, "tool_use_id": "u2"})
        self.assertEqual(len(self.server.requests), 3)

    def test_background_commands_are_still_refused(self):
        out = self.hook("PreToolUse", tool_name="Bash", tool_input={"command": "x", "run_in_background": True})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(self.server.requests, [])

    def test_other_callers_get_the_raw_reply_and_the_same_render(self):
        reply = {"workspace": "crew", "position": 9, "items": [{"title": "Rule", "body": "Keep scope.", "tags": ["a", "b"]}]}
        self.server.replies.append((200, reply))
        (self.folder / "config.json").write_text(json.dumps(self.config))
        env = {**self.env, "LANE_MEMORY_CONFIG": str(self.folder / "config.json")}
        cli = str(HOOKS / "joppa-data.sh")
        self.assertTrue(os.access(cli, os.X_OK))
        read = subprocess.run([cli, "session"], env=env, capture_output=True, text=True, timeout=30, check=True)
        self.assertEqual(json.loads(read.stdout), reply)
        shown = subprocess.run([cli, "render", '["tags"]'], input=read.stdout, env=env,
                               capture_output=True, text=True, timeout=30, check=True)
        self.assertEqual(shown.stdout, "## Rule\nKeep scope.\ntags: a, b\n")

    def test_the_key_stays_out_of_arguments_and_environment(self):
        script = (HOOKS / "joppa-data.sh").read_text() + (HOOKS / "memory-hook.sh").read_text()
        self.assertNotIn("Authorization: Bearer $(", script)
        self.assertIn("-K -", (HOOKS / "joppa-data.sh").read_text())


if __name__ == "__main__":
    unittest.main()
