import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from responses import final_response


class ResponseTests(unittest.TestCase):
    def test_tool_output_and_intermediate_text_are_not_final_deliveries(self):
        final = {"verdict": "clear"}
        raw = json.dumps(final)
        cases = {
            "codex": [{"type": "item.completed", "item": {"type": "command_execution", "text": raw}},
                      {"type": "item.completed", "item": {"type": "agent_message", "text": raw}}],
            "claude-code": [{"type": "assistant", "message": {"content": [{"type": "text", "text": "intermediate"}]}},
                            {"type": "result", "is_error": False, "result": {"output": raw}}],
            "agy": [{"event": "step_update", "step_update": {"step_type": "tool", "text_delta": "wrong"}},
                    {"event": "result", "result": {"status": "SUCCESS", "response": raw}}],
            "opencode": [{"type": "text", "part": {"messageID": "first", "text": "intermediate"}},
                         {"type": "tool_use", "part": {"text": "wrong"}},
                         {"type": "text", "part": {"messageID": "last", "text": raw[:10]}},
                         {"type": "text", "part": {"messageID": "last", "text": raw[10:]}}],
        }
        for harness, events in cases.items():
            with self.subTest(harness=harness):
                self.assertEqual(final_response(events, harness), final)

    def test_failed_and_incomplete_results_cannot_deliver(self):
        for harness, events in (
            ("codex", [{"type": "item.completed", "item": {"type": "command_execution", "text": "{}"}}]),
            ("claude-code", [{"type": "result", "is_error": True, "result": "{}"}]),
            ("agy", [{"event": "result", "result": {"status": "FAILED", "response": "{}"}}]),
            ("agy", [{"event": "step_update", "step_update": {"step_type": "agent_response", "text_delta": "{}"}}]),
            ("opencode", [{"type": "error"}, {"type": "text", "part": {"text": "{}"}}]),
        ):
            with self.subTest(harness=harness):
                with self.assertRaises(ValueError):
                    final_response(events, harness)
