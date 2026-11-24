"""Render each workflow prompt with large bodies through the real Medulla renderer."""
import ast
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

try:
    import yaml
    from medulla.v2.render import render
    from medulla.v2.signals import SIGNAL_PROTOCOL
except ImportError:
    render = None


class PromptLimits(unittest.TestCase):
    @unittest.skipIf(render is None, "Needs the Medulla Python environment")
    def test_actual_rendered_prompts_keep_large_bodies_in_files(self):
        root = Path(__file__).resolve().parents[2]
        marker = "BODY_MUST_STAY_IN_FILE_"
        huge = marker * 10000
        count, maximum = 0, 0
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / ('r' * (139 - len(directory)))
            folder.mkdir()
            fixture = folder / "large.json"
            fixture.write_text(json.dumps({"body": huge}))
            selected = os.environ.get("CREW_PROMPT_WORKFLOWS", "").split()
            for workflow in sorted(root.glob("*/workflow.yaml")):
                if selected and workflow.parent.name not in selected:
                    continue
                flow = yaml.safe_load(workflow.read_text())
                for name, node in flow.get("nodes", {}).items():
                    if "agent" not in node or "prompt" not in node:
                        continue
                    values = {key: str(value) for key, value in flow.get("vars", {}).items()}
                    for key in re.findall(r"\{\{var:([^}:]+)", node["prompt"]):
                        is_path = re.search(r"path|file|folder|root|dir|artifacts", key, re.I)
                        is_body = re.search(r"contract|assignment|draft|critique|research|necessity|feedback|commands|test_report|test_command", key, re.I)
                        is_address = re.search(r"_ac$|address$|item_id$|ticket_id$", key)
                        values[key] = (str(folder) if 'artifacts' in key.lower() else str(fixture)) if is_path else \
                            huge if is_body else 'ac:11111111-2222-3333-4444-555555555555' if is_address else "example"
                    if workflow.parent.name == "decider":
                        source = workflow.with_name('agent-files.mjs')
                        control = (source if source.exists() else workflow.with_name('control.mjs')).read_text()
                        retry = re.search(r"export const RETRY = ('.*?');", control).group(1)
                        values['decider_feedback'] = ast.literal_eval(retry)
                    seats = node.get("inputs")
                    seats = seats if isinstance(seats, list) else [{"slug": "example"}]
                    for seat in seats:
                        for round_number in ("1", "2", "4"):
                            values["round"] = round_number
                            prompt = render(node["prompt"], workflow.parent, values,
                                            seat, True, last={"message": huge}) + SIGNAL_PROTOCOL
                            with self.subTest(workflow=workflow.parent.name, node=name, round=round_number):
                                self.assertLessEqual(len(prompt), 1024)
                                self.assertNotIn(marker, prompt)
                                self.assertNotIn("{{", prompt)
                            count += 1
                            maximum = max(maximum, len(prompt))
        self.assertGreater(count, 0)
        print(json.dumps({"renderer": "medulla.v2.render.render", "cases": count,
                          "max_chars": maximum, "includes_signal_protocol": True}))


if __name__ == "__main__":
    unittest.main()
