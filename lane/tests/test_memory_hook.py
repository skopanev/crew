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
        count = len(self.server.requests)
        for root in ("", "   ", None, 123, []):
            with self.subTest(root=root):
                self.config["root"] = root
                out = self.hook("SessionStart")
                self.assertIs(out["continue"], False)
                self.assertIn("config root", out["stopReason"])
                self.assertEqual(len(self.server.requests), count)
        # The workspace follows the same rule: omitted is the key default, explicit must be valid.
        del self.config["root"]
        del self.config["workspace"]
        self.server.replies.append((200, {"items": [{"address": "rule:r", "body": "Keep scope."}]}))
        self.assertNotIn("continue", self.hook("SessionStart"))
        self.assertNotIn("workspace", self.server.requests[-1]["body"])
        count = len(self.server.requests)
        for workspace in ("", "   ", None, 123, []):
            with self.subTest(workspace=workspace):
                self.config["workspace"] = workspace
                out = self.hook("SessionStart")
                self.assertIs(out["continue"], False)
                self.assertIn("config workspace", out["stopReason"])
                self.assertEqual(len(self.server.requests), count)

    def test_session_start_stops_the_lane_without_a_contract(self):
        # A caller that supplies the contract itself turns the read off; nothing is read or stopped.
        self.env["LANE_MEMORY_SESSION"] = "off"
        out = self.hook("SessionStart")
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ""}})
        self.assertEqual(self.server.requests, [])
        del self.env["LANE_MEMORY_SESSION"]
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
        lesson = {"address": "lesson:l", "revision": 1, "title": "Lesson", "body": "Use rtk."}
        self.server.replies.append((200, {"items": [lesson]}))
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
        # The session has this revision already, from any event; a new revision is shown again.
        self.server.replies.append((200, {"items": [lesson]}))
        self.assertEqual(self.hook("PostToolUse", tool_name="Bash", tool_use_id="t9",
                                   tool_input={"description": "Run the gate"})["hookSpecificOutput"]["additionalContext"], "")
        self.server.replies.append((200, {"items": [{**lesson, "revision": 2, "body": "Use rtk proxy."}]}))
        self.assertEqual(self.hook("UserPromptSubmit", prompt="gate")["hookSpecificOutput"]["additionalContext"],
                         "## Lesson\nUse rtk proxy.")
        # Parallel events of one session deliver a lesson once.
        parallel = {"address": "lesson:p", "revision": 1, "title": "Parallel", "body": "Once."}
        self.server.replies.extend((200, {"items": [parallel]}) for _ in range(4))
        (self.folder / "config.json").write_text(json.dumps(self.config))
        runs = [subprocess.Popen(["bash", str(HOOKS / "memory-hook.sh")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 env={**self.env, "LANE_MEMORY_CONFIG": str(self.folder / "config.json")}, text=True)
                for _ in range(4)]
        for number, run in enumerate(runs):
            run.stdin.write(json.dumps({"hook_event_name": "UserPromptSubmit", "session_id": "s1",
                                        "prompt": f"parallel {number}"}))
            run.stdin.close()
        shown = [json.loads(run.stdout.read())["hookSpecificOutput"]["additionalContext"] for run in runs]
        for run in runs:
            run.wait(timeout=30)
        self.assertEqual(sorted(shown), ["", "", "", "## Parallel\nOnce."])
        # Another session has received nothing yet.
        self.server.replies.append((200, {"items": [lesson]}))
        self.assertEqual(self.hook("UserPromptSubmit", prompt="gate", session_id="s2")
                         ["hookSpecificOutput"]["additionalContext"], "## Lesson\nUse rtk.")
        # A refused render marks nothing delivered.
        other = {"address": "lesson:m", "revision": 1, "title": "Other", "body": "Read the log."}
        self.server.replies.append((200, {"items": [other]}))
        self.env["LANE_MEMORY_DATA"] = str(self.folder / "broken-render.sh")
        (self.folder / "broken-render.sh").write_text(
            '[[ "$1" == render ]] && exit 1; exec bash %s "$@"\n' % (HOOKS / "joppa-data.sh"))
        self.assertIn("cannot render", self.hook("UserPromptSubmit", prompt="log")["systemMessage"])
        del self.env["LANE_MEMORY_DATA"]
        self.server.replies.append((200, {"items": [other]}))
        self.assertEqual(self.hook("UserPromptSubmit", prompt="log")["hookSpecificOutput"]["additionalContext"],
                         "## Other\nRead the log.")

    def agy(self, event, payload):
        (self.folder / "config.json").write_text(json.dumps(self.config))
        self.env["LANE_MEMORY_CONFIG"] = str(self.folder / "config.json")
        result = subprocess.run(["bash", str(HOOKS / "agy-memory.sh"), event], input=json.dumps(payload),
                                env=self.env, capture_output=True, text=True, timeout=30, check=True)
        return json.loads(result.stdout)

    def test_agy_records_calls_and_retrieves_once_at_the_next_model_call(self):
        call = lambda command: {"conversationId": "c1", "transcriptPath": "/t",
                                "toolCall": {"name": "run_command", "args": {"CommandLine": command, "toolSummary": "Run"}}}
        self.assertEqual(self.agy("PreToolUse", call("bun test life")), {"decision": "allow"})
        self.assertEqual(self.server.requests, [])
        [record] = self.folder.glob("lane-agy-calls.*")
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        lesson = {"address": "lesson:l", "revision": 1, "title": "Tests", "body": "Run focused tests."}
        self.server.replies.append((200, {"items": [lesson]}))
        out = self.agy("PreInvocation", {"conversationId": "c1", "transcriptPath": "/t"})
        self.assertEqual(out, {"injectSteps": [{"ephemeralMessage": "## Tests\nRun focused tests."}]})
        self.assertEqual(self.server.requests[0]["body"]["query"], "bun test life Run")
        # The calls are taken once; a delivered lesson is not delivered again.
        self.assertEqual(self.agy("PreInvocation", {"conversationId": "c1"}), {})
        self.assertEqual(len(self.server.requests), 1)
        self.agy("PreToolUse", call("bun test life again"))
        self.server.replies.append((200, {"items": [lesson]}))
        self.assertEqual(self.agy("PreInvocation", {"conversationId": "c1"}), {})
        self.assertEqual(len(self.server.requests), 2)
        # The record keeps the last 10 calls. Stop removes it and lets the agent stop.
        for number in range(12):
            self.agy("PreToolUse", call(f"step {number}"))
        self.assertEqual([c["tool_input"]["CommandLine"] for c in json.loads(record.read_text())],
                         [f"step {number}" for number in range(2, 12)])
        self.assertEqual(self.agy("Stop", {"conversationId": "c1"}), {})
        self.assertFalse(record.exists())
        # A failed retrieval reaches the model as a warning; no conversation stays neutral.
        self.agy("PreToolUse", call("gate"))
        self.server.replies.append((503, {}))
        out = self.agy("PreInvocation", {"conversationId": "c1"})
        self.assertIn("lane memory: retrieval failed: HTTP 503", out["injectSteps"][0]["ephemeralMessage"])
        self.assertEqual(self.agy("PreToolUse", {}), {"decision": "allow"})
        self.assertEqual(self.agy("SessionStart", {"conversationId": "c1"}), {})

    def test_agy_home_prepares_sign_in_and_wires_hooks_only_for_selected_memory_queries(self):
        home, bins = self.folder / "agy", self.folder / "bin"
        bins.mkdir()
        token = home / ".gemini/antigravity-cli/antigravity-oauth-token"
        broker = bins / "broker-agy"
        env = {**self.env, "HOME": str(home), "PATH": f"{bins}:{os.environ['PATH']}", "TOOLING_ROOT": "/workspace",
               "MEDULLA_DOCKER": "1"}
        memory = {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [
            {"type": "command", "command": "bash /workspace/lane/hooks/memory-hook.sh"}]}]}}
        settings = self.folder / "settings.json"
        def run(selected, broker_script, **changes):
            settings.write_text(json.dumps(selected))
            broker.write_text("#!/bin/sh\n" + broker_script)
            broker.chmod(0o755)
            return subprocess.run(["bash", str(HOOKS / "agy-home.sh"), str(settings)], env={**env, **changes},
                                  capture_output=True, text=True, timeout=30)
        writes_token = (f'mkdir -p "$BROKER_AGY_HOME/.gemini/antigravity-cli"\n'
                        f"echo '{{\"token\": {{}}}}' > {token}\n")
        # A host run writes nothing, not even through a working Broker.
        result = run(memory, writes_token, MEDULLA_DOCKER="")
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs medulla --docker", result.stderr)
        self.assertFalse(home.exists())
        # The lane requires AGY: a failed or missing Broker stops startup, with its code, before any hook.
        result = run(memory, "echo secret-value >&2\nexit 7\n")
        self.assertEqual(result.returncode, 7)
        self.assertIn("AGY_AUTH_UNAVAILABLE: broker-agy exited 7", result.stderr)
        self.assertNotIn("secret-value", result.stderr)
        self.assertEqual(run(memory, "exit 0\n").returncode, 1)
        self.assertFalse((home / ".gemini/config/hooks.json").exists())
        broker.unlink()
        result = subprocess.run(["bash", str(HOOKS / "agy-home.sh"), str(settings)], env={**env, "PATH": f"{bins}:/usr/bin:/bin"},
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no usable token and no broker-agy", result.stderr)
        # Broker prepares the private token once and the hooks are wired.
        result = run(memory, writes_token)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("prepared through Broker", result.stderr)
        hooks = json.loads((home / ".gemini/config/hooks.json").read_text())["crew-lane-memory"]
        self.assertEqual(hooks["PreToolUse"], [{"matcher": ".*", "hooks": [{"type": "command", "timeout": 10,
            "command": f"bash /workspace/lane/hooks/agy-memory.sh PreToolUse"}]}])
        self.assertEqual([h["command"].split()[-1] for e in ("PreInvocation", "Stop") for h in hooks[e]],
                         ["PreInvocation", "Stop"])
        # A usable token is never refreshed here.
        result = run(memory, f"echo called > {self.folder}/second-call\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.folder / "second-call").exists())
        # Another hooks file is refused. Only Crew's own memory command wires the hooks:
        # not a Stop hook, and not another script with a similar name.
        (home / ".gemini/config/hooks.json").write_text('{"other": {}}')
        self.assertEqual(run(memory, "exit 0\n").returncode, 1)
        (home / ".gemini/config/hooks.json").unlink()
        other = {"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "bash /work/my-memory-hook.sh"}]}]}}
        for selected in ({"hooks": {"Stop": memory["hooks"]["PreToolUse"]}}, other):
            self.assertIn("AGY hooks off", run(selected, "exit 0\n").stderr)
            self.assertFalse((home / ".gemini/config/hooks.json").exists())
        bundled = {"hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "/usr/bin/env bash <TOOLING_ROOT>/lane/hooks/memory-hook.sh"}]}]}}
        self.assertEqual(run(bundled, "exit 0\n").returncode, 0)
        self.assertTrue((home / ".gemini/config/hooks.json").exists())

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
        out = self.hook("PreToolUse", tool_name="Bash", tool_use_id="b1",
                        tool_input={"command": "x", "description": "Start the server", "run_in_background": True})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(self.server.requests, [])
        # An allowed call retrieves on what the agent is about to do, and grants nothing.
        self.server.replies.append((200, {"items": [{"address": "lesson:g", "revision": 1, "title": "Gate",
                                                    "body": "Run it with bun."}]}))
        call = {"tool_name": "Bash", "tool_use_id": "f1", "tool_input": {"command": "bun test", "description": "Run the gate"}}
        out = self.hook("PreToolUse", **call)
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                      "additionalContext": "## Gate\nRun it with bun."}})
        self.assertEqual(self.server.requests[0]["body"]["query"], "bun test Run the gate")
        # Once before the call; after it, the result is new information.
        self.hook("PreToolUse", **call)
        self.assertEqual(len(self.server.requests), 1)
        self.hook("PostToolUse", **call, tool_response="error: gate failed")
        self.assertEqual(len(self.server.requests), 2)
        # The query is the actual input, whatever the tool is called: a bare command, a native
        # exec with an argument list, a patch.
        for tool, tool_input, query in (
                ("Bash", {"command": "bun run gate"}, "bun run gate"),
                ("exec", {"command": ["bun", "test"], "workdir": "/workspace"}, "bun test /workspace"),
                ("apply_patch", {"input": "*** Update File: src/a.ts"}, "*** Update File: src/a.ts")):
            with self.subTest(tool=tool):
                self.hook("PreToolUse", tool_name=tool, tool_use_id="n-" + tool, tool_input=tool_input)
                self.assertEqual(self.server.requests[-1]["body"]["query"], query)

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

    def test_custom_hooks_startup_and_injection_preserve_defaults_and_custom_commands(self):
        startup = HOOKS.parent / "startup/hooks.sh"
        probe = (
            "set -euo pipefail\n"
            'say() { printf "%s\\n" "$*"; }\n'
            "mounts=()\n"
            f'source "{startup}"\n'
            'jq -cn --argjson mounts "$((( ${#mounts[@]} )) && printf "%s\\0" "${mounts[@]}" | jq -Rs "split(\\"\\u0000\\")[:-1]" || echo "[]")" '
            '--argjson vars "$((( ${#hooks_vars[@]} )) && printf "%s\\0" "${hooks_vars[@]}" | jq -Rs "split(\\"\\u0000\\")[:-1]" || echo "[]")" '
            '"{mounts: \\$mounts, vars: \\$vars}"\n'
        )
        default_run = subprocess.run(["bash", "-c", probe], env=dict(os.environ, LANE_HOOKS_DIR=""),
                                     capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(default_run.stdout.splitlines()[-1]), {"mounts": [], "vars": []})

        hooks_dir = self.folder / "crew-hooks-custom"
        hooks_dir.mkdir()
        missing = subprocess.run(["bash", "-c", probe], env=dict(os.environ, LANE_HOOKS_DIR=str(hooks_dir)),
                                 capture_output=True, text=True)
        self.assertEqual(missing.returncode, 2)

        custom_settings = self.folder / "crew-hooks-custom/settings.json"
        custom_settings.write_text('{"hooks": []}')
        invalid = subprocess.run(["bash", "-c", probe], env=dict(os.environ, LANE_HOOKS_DIR=str(hooks_dir)),
                                 capture_output=True, text=True)
        self.assertEqual(invalid.returncode, 2)

        custom_settings.write_text(json.dumps({
            "permissions": {"allow": ["Bash(*pytest*)"], "deny": ["Bash(*rm -rf*)"]},
            "env": {"CUSTOM_HOOK_ENV": "1"},
            "hooks": {
                "SessionStart": [{
                    "matcher": "startup",
                    "hooks": [
                        {"type": "command", "command": "/usr/bin/env bash <TOOLING_ROOT>/lane/hooks/memory-hook.sh"},
                        {"type": "command", "command": "bash /workspace/project/lane/custom-hook.sh"},
                    ],
                }],
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk hook claude"}]},
                    {"matcher": "Edit", "hooks": [{"type": "command", "command": "/opt/project/check-edit.sh"}]},
                ],
            },
        }))
        ready = subprocess.run(["bash", "-c", probe], env=dict(os.environ, LANE_HOOKS_DIR=str(hooks_dir)),
                               capture_output=True, text=True, check=True)
        parsed = json.loads(ready.stdout.splitlines()[-1])
        self.assertEqual(parsed["mounts"], ["--mount", str(hooks_dir)])
        self.assertEqual(parsed["vars"], [f"--var", f"LANE_HOOKS_CONFIG=/workspace/{hooks_dir.name}/settings.json"])

        tooling = self.folder / "tooling"
        injected = self.folder / "injected.json"
        codex_home = self.folder / "codex-home"
        env = dict(os.environ, TOOLING_ROOT=str(tooling), LANE_HOOKS_CONFIG=str(custom_settings),
                   CBM_MCP_COMMAND=str(self.folder / "cbm.py"))
        subprocess.run(["bash", str(HOOKS / "inject.sh"), str(injected), str(HOOKS / "claude-settings.json")],
                       env=env, check=True, capture_output=True, text=True)
        subprocess.run(["bash", str(HOOKS / "codex-home.sh"), str(codex_home), str(injected)],
                       env=env, check=True, capture_output=True, text=True)

        claude = json.loads(injected.read_text())
        codex = json.loads((codex_home / "hooks.json").read_text())
        self.assertEqual(claude["permissions"]["defaultMode"], "auto")
        self.assertIn("Bash(*git *)", claude["permissions"]["allow"])
        self.assertIn("Bash(*pytest*)", claude["permissions"]["allow"])
        self.assertIn("Bash(*git push*)", claude["permissions"]["deny"])
        self.assertIn("Bash(*rm -rf*)", claude["permissions"]["deny"])
        self.assertEqual(claude["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1")
        self.assertEqual(claude["env"]["CUSTOM_HOOK_ENV"], "1")
        session_hooks = claude["hooks"]["SessionStart"][0]["hooks"]
        self.assertEqual(session_hooks[0]["command"], f"bash {tooling}/lane/hooks/memory-hook.sh")
        self.assertEqual(session_hooks[1]["command"], "bash /workspace/project/lane/custom-hook.sh")
        self.assertEqual(codex["hooks"]["SessionStart"], claude["hooks"]["SessionStart"])
        self.assertEqual(codex["hooks"]["PreToolUse"][0]["matcher"], "*")
        self.assertEqual(codex["hooks"]["PreToolUse"][1]["matcher"], "Edit")
        self.assertEqual(json.loads((codex_home / "mcp.json").read_text())["mcpServers"]["codebase-memory"],
                         {"command": "python3", "args": [str(self.folder / "cbm.py")]})


if __name__ == "__main__":
    unittest.main()
